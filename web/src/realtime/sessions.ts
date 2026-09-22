/**
 * `SessionRegistry`: the one `GameSession` per game the realtime process
 * holds in memory (plan Task 3). A session is loaded from Postgres on first
 * use — `Game.moveLog` replayed by the engine, seats from `GameSeat`, the
 * chat tail, `updatedAt` as the idle clock — with concurrent requests for
 * the same game sharing one load (single flight) and a failed load never
 * cached. Writes go through `PrismaSessionStore` (`session-store.ts`).
 *
 * Sockets hold a *lease* (`acquire` → `release`): a session with no lease
 * for 30 min is evicted, one whose game finished (or that loaded already
 * finished/abandoned) is evicted 60 s later, and the sweep — every 10 min
 * — marks games with no action for 24 h `abandoned` (spec §5.4), evicting
 * their sessions. Eviction disposes the session (its next-game timer) and
 * calls `onEvicted`, so the WebSocket layer can close or re-attach its
 * sockets; a later `get` rebuilds the session from the row, which is how
 * an abandoned game becomes read-only without a mutator on `GameSession`.
 * The sweep guards its update on `updatedAt` so an action accepted at the
 * same moment wins, and evicts a session only once that update has changed
 * the row — never on the mere suspicion of the `findMany` — so a live
 * session with sockets attached is not dropped for nothing; a stale
 * session cannot write to an abandoned row because the store's update is
 * guarded on the status too.
 *
 * The seat of the invitee is claimed by the Next.js process, not this
 * one: while a seat is open, every `get` re-reads the seats so the
 * invitee's `join` finds both claimed and draws the opening roll.
 *
 * The server layer hears about abandoned games and timer-driven
 * broadcasts either through the constructor options or by subscribing
 * with `onAbandoned(cb)` / `onBroadcast(cb)` (the shape `server.ts`'s
 * `Registry` expects); both are called.
 */

import type { EngineSync } from "@/engine/sync";

import { log as processLog, type Logger } from "./log";
import type { ServerMsg } from "./protocol";
import { GameSession } from "./session";
import { LIVE_STATUSES, PrismaSessionStore, loadGameRow, loadSeats, type SessionDb } from "./session-store";
import { defaultTimer, type GameStatus, type SessionStore, type SessionTimer, type StoredResult } from "./session-types";
import type { Record as GameRecord } from "@/engine/types";

export { PrismaSessionStore, SessionStoreError, type SessionDb } from "./session-store";

/** How long a finished (or abandoned) session stays in memory after the write that ended it. */
export const FINISHED_EVICT_MS = 60_000;
/** How long a session stays in memory with no socket attached. */
export const IDLE_EVICT_MS = 30 * 60_000;
/** How often the abandonment sweep runs. */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** A game with no action for this long is abandoned. */
export const ABANDON_AFTER_MS = 24 * 60 * 60_000;

export type EvictReason = "finished" | "idle" | "abandoned" | "shutdown";

export interface SessionRegistryOptions {
  db: SessionDb;
  engine: EngineSync;
  /** Clock in ms since the epoch; `Date.now` by default. */
  now?: () => number;
  /** Timer for eviction and the sweep (and the sessions' next-game timer); `setTimeout` by default. */
  timer?: SessionTimer;
  logger?: Logger;
  /** A broadcast no message triggered (a session's next game starting on its timer). */
  onBroadcast?: (gameId: string, msgs: ServerMsg[]) => void;
  /** A session left memory; sockets attached to it should be closed or re-attached. */
  onEvicted?: (gameId: string, reason: EvictReason) => void;
  /** The sweep marked a game abandoned (in memory or not). */
  onAbandoned?: (gameId: string) => void;
}

/** A socket's hold on a session; `release` is idempotent and harmless after eviction. */
export interface SessionLease {
  session: GameSession;
  release(): void;
}

interface Entry {
  session: GameSession;
  leases: number;
  idleTimer: unknown;
  finishTimer: unknown;
}

const isReadOnly = (status: GameStatus): boolean => status === "finished" || status === "abandoned";

const bothClaimed = (session: GameSession): boolean => session.seats.every((s) => s.name !== null);

export class SessionRegistry {
  private readonly db: SessionDb;
  private readonly engine: EngineSync;
  private readonly now: () => number;
  private readonly timer: SessionTimer;
  private readonly log: Logger;
  private readonly options: SessionRegistryOptions;
  private readonly store: SessionStore;

  private readonly sessions = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<GameSession | null>>();
  private readonly abandonedSubscribers: ((gameId: string) => void)[] = [];
  private readonly broadcastSubscribers: ((gameId: string, msgs: ServerMsg[]) => void)[] = [];
  private sweepTimer: unknown = null;
  private stopped = false;

  constructor(options: SessionRegistryOptions) {
    this.options = options;
    this.db = options.db;
    this.engine = options.engine;
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? defaultTimer;
    this.log = options.logger ?? processLog.child({ component: "sessions" });
    this.store = new PrismaSessionStore(this.db, this.now);
  }

  /** Sessions in memory. */
  get size(): number {
    return this.sessions.size;
  }

  /** Subscribes to the sweep marking a game abandoned (in addition to `options.onAbandoned`). */
  onAbandoned(cb: (gameId: string) => void): void {
    this.abandonedSubscribers.push(cb);
  }

  /** Subscribes to broadcasts no message triggered (in addition to `options.onBroadcast`). */
  onBroadcast(cb: (gameId: string, msgs: ServerMsg[]) => void): void {
    this.broadcastSubscribers.push(cb);
  }

  /** The session if it is in memory; never loads. */
  peek(gameId: string): GameSession | null {
    return this.sessions.get(gameId)?.session ?? null;
  }

  /**
   * The session for `gameId`, loaded from the database when not in memory
   * (one load shared by concurrent callers); `null` when there is no such
   * remote game. Rejects when the stored record is malformed or the
   * database fails; nothing is cached then.
   */
  async get(gameId: string): Promise<GameSession | null> {
    const entry = this.sessions.get(gameId);
    if (entry !== undefined) {
      if (!bothClaimed(entry.session)) {
        await this.refreshSeats(gameId);
      }
      return entry.session;
    }
    const pending = this.loading.get(gameId);
    if (pending !== undefined) {
      return pending;
    }
    const load = this.load(gameId).finally(() => this.loading.delete(gameId));
    this.loading.set(gameId, load);
    return load;
  }

  /** `get` plus a lease for a socket; `null` when there is no such game. */
  async acquire(gameId: string): Promise<SessionLease | null> {
    const session = await this.get(gameId);
    const entry = this.sessions.get(gameId);
    if (session === null || entry === undefined || entry.session !== session) {
      return null;
    }
    entry.leases += 1;
    this.clearIdle(entry);
    let released = false;
    return {
      session,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (this.sessions.get(gameId) !== entry) {
          return;
        }
        entry.leases -= 1;
        if (entry.leases === 0) {
          this.armIdle(gameId, entry);
        }
      },
    };
  }

  /** Re-reads the seats of an in-memory session (the invitee claims in the API process). */
  async refreshSeats(gameId: string): Promise<void> {
    const entry = this.sessions.get(gameId);
    if (entry === undefined) {
      return;
    }
    const seats = await loadSeats(this.db, gameId);
    for (const seat of seats) {
      if (entry.session.seats[seat.seat].name !== seat.name) {
        entry.session.setSeat(seat.seat, seat);
      }
    }
  }

  /** Drops the session from memory (disposing it); `true` when one was there. */
  evict(gameId: string, reason: EvictReason): boolean {
    const entry = this.sessions.get(gameId);
    if (entry === undefined) {
      return false;
    }
    this.sessions.delete(gameId);
    this.clearIdle(entry);
    if (entry.finishTimer !== null) {
      this.timer.clear(entry.finishTimer);
      entry.finishTimer = null;
    }
    entry.session.dispose();
    this.log.info("session evicted", { gameId, reason, status: entry.session.status, leases: entry.leases });
    this.options.onEvicted?.(gameId, reason);
    return true;
  }

  /**
   * Marks every remote game with no action for `ABANDON_AFTER_MS`
   * `abandoned`, evicting those in memory; resolves to the ids it changed.
   */
  async sweep(): Promise<string[]> {
    const cutoffMs = this.now() - ABANDON_AFTER_MS;
    const cutoff = new Date(cutoffMs);
    const live = { in: [...LIVE_STATUSES] };
    const rows = await this.db.game.findMany({
      where: { status: live, token: { not: null }, updatedAt: { lt: cutoff } },
      select: { id: true },
    });
    const abandoned: string[] = [];
    for (const { id } of rows) {
      const entry = this.sessions.get(id);
      if (entry !== undefined && entry.session.lastActionAt >= cutoffMs) {
        // An action was committed since the row was read: next time. (A write still in
        // flight is not covered here; the guarded update below is what decides.)
        continue;
      }
      const { count } = await this.db.game.updateMany({
        where: { id, status: live, updatedAt: { lt: cutoff } },
        data: { status: "abandoned" },
      });
      if (count === 0) {
        // An action landed meanwhile (`@updatedAt` moved the clock): the game lives on, session and leases untouched.
        continue;
      }
      // The row is abandoned: drop the session in memory — the one seen before the update, or
      // one a concurrent `get` rebuilt from the row before it changed.
      await this.loading.get(id)?.catch(() => null);
      const stale = this.sessions.get(id);
      if (stale !== undefined && stale.session.status !== "abandoned") {
        this.evict(id, "abandoned");
      }
      abandoned.push(id);
      this.log.info("game abandoned", { gameId: id });
      this.notifyAbandoned(id);
    }
    return abandoned;
  }

  /** Arms the periodic sweep; idempotent. */
  start(): void {
    if (this.sweepTimer !== null || this.stopped) {
      return;
    }
    this.armSweep();
  }

  /** Stops the sweep and evicts every session (graceful shutdown); nothing loads afterwards. */
  stop(): void {
    this.stopped = true;
    if (this.sweepTimer !== null) {
      this.timer.clear(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const gameId of [...this.sessions.keys()]) {
      this.evict(gameId, "shutdown");
    }
  }

  // -------------------------------------------------------------------------

  private async load(gameId: string): Promise<GameSession | null> {
    if (this.stopped) {
      return null;
    }
    const loaded = await loadGameRow(this.db, gameId);
    if (loaded === null) {
      return null;
    }
    const holder: { entry: Entry | null } = { entry: null };
    const session = new GameSession({
      gameId,
      record: loaded.record,
      seats: loaded.seats,
      status: loaded.status,
      chat: loaded.chat,
      lastActionAt: loaded.lastActionAt,
      engine: this.engine,
      store: this.trackingStore(gameId, holder),
      now: this.now,
      timer: this.timer,
      onBroadcast: (msgs) => this.notifyBroadcast(gameId, msgs),
    });
    if (this.stopped) {
      session.dispose();
      return null;
    }
    const entry: Entry = { session, leases: 0, idleTimer: null, finishTimer: null };
    holder.entry = entry;
    this.sessions.set(gameId, entry);
    this.log.info("session loaded", { gameId, status: session.status, turns: session.record.turns.length });
    if (isReadOnly(session.status)) {
      this.armFinish(gameId, entry);
    } else {
      this.armIdle(gameId, entry);
    }
    return session;
  }

  /** The store of one session: the finishing write arms that session's eviction. */
  private trackingStore(gameId: string, holder: { entry: Entry | null }): SessionStore {
    return {
      saveTurns: async (id: string, record: GameRecord, status: GameStatus, result?: StoredResult): Promise<void> => {
        await this.store.saveTurns(id, record, status, result);
        const entry = this.sessions.get(gameId);
        if (status === "finished" && entry !== undefined && entry === holder.entry) {
          this.armFinish(gameId, entry);
        }
      },
      saveChat: (id, line) => this.store.saveChat(id, line),
    };
  }

  private notifyAbandoned(gameId: string): void {
    this.options.onAbandoned?.(gameId);
    for (const cb of this.abandonedSubscribers) {
      cb(gameId);
    }
  }

  private notifyBroadcast(gameId: string, msgs: ServerMsg[]): void {
    this.options.onBroadcast?.(gameId, msgs);
    for (const cb of this.broadcastSubscribers) {
      cb(gameId, msgs);
    }
  }

  private armFinish(gameId: string, entry: Entry): void {
    if (entry.finishTimer !== null) {
      return;
    }
    entry.finishTimer = this.timer.set(() => {
      entry.finishTimer = null;
      if (this.sessions.get(gameId) === entry) {
        this.evict(gameId, "finished");
      }
    }, FINISHED_EVICT_MS);
  }

  private armIdle(gameId: string, entry: Entry): void {
    this.clearIdle(entry);
    entry.idleTimer = this.timer.set(() => {
      entry.idleTimer = null;
      if (this.sessions.get(gameId) === entry && entry.leases === 0) {
        this.evict(gameId, "idle");
      }
    }, IDLE_EVICT_MS);
  }

  private clearIdle(entry: Entry): void {
    if (entry.idleTimer !== null) {
      this.timer.clear(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  private armSweep(): void {
    this.sweepTimer = this.timer.set(() => {
      this.sweepTimer = null;
      void this.sweep()
        .catch((error: unknown) => {
          this.log.error("abandonment sweep failed", { error });
        })
        .finally(() => {
          if (!this.stopped) {
            this.armSweep();
          }
        });
    }, SWEEP_INTERVAL_MS);
  }
}
