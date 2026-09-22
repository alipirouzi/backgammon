/**
 * The open sockets of the realtime server (server.ts) and the limits that
 * hang off them. Sockets are indexed by game (in the order they attached)
 * so a broadcast reaches every socket of a game and presence is "any socket
 * of the seat is open". A seat may hold at most `MAX_SOCKETS_PER_SEAT`
 * sockets at once: when one more attaches, `beyondCap` names the oldest for
 * the server to close (4001, server.ts). The message rate limit
 * (`limits.ts`) is one budget per *seat* of a game, shared by all its
 * sockets — so opening more sockets buys no more messages. A seat's limiter
 * is dropped once its last socket has closed and its window has passed.
 */

import type { WebSocket } from "ws";

import type { SeatIndex } from "./auth";
import { RATE_WINDOW_MS, createSocketLimiter, type SocketLimiter } from "./limits";
import type { SessionLease } from "./server";

/** Open sockets one seat of one game may hold at once (a few tabs, not a flood). */
export const MAX_SOCKETS_PER_SEAT = 4;

export interface Connection {
  readonly ws: WebSocket;
  readonly gameId: string;
  readonly seat: SeatIndex;
  readonly lease: SessionLease;
  /** The last frame or pong seen, on the server's clock; for the heartbeat. */
  lastSeenAt: number;
  readonly closed: Promise<void>;
}

interface SeatBudget {
  readonly limiter: SocketLimiter;
  lastHitAt: number;
}

export class ConnectionTable {
  private readonly byGame = new Map<string, Set<Connection>>();
  private readonly budgets = new Map<string, SeatBudget>();

  constructor(private readonly now: () => number) {}

  add(conn: Connection): void {
    const set = this.byGame.get(conn.gameId) ?? new Set<Connection>();
    set.add(conn);
    this.byGame.set(conn.gameId, set);
    this.pruneBudgets();
  }

  remove(conn: Connection): void {
    const set = this.byGame.get(conn.gameId);
    set?.delete(conn);
    if (set?.size === 0) {
      this.byGame.delete(conn.gameId);
    }
    this.pruneBudgets();
  }

  /** The open sockets of `gameId`, a copy safe to iterate while sockets close. */
  of(gameId: string): readonly Connection[] {
    return [...(this.byGame.get(gameId) ?? [])];
  }

  all(): readonly Connection[] {
    return [...this.byGame.values()].flatMap((set) => [...set]);
  }

  /** The open sockets of `seat` of `gameId`, oldest first. */
  ofSeat(gameId: string, seat: SeatIndex): readonly Connection[] {
    return this.of(gameId).filter((c) => c.seat === seat);
  }

  seatCount(gameId: string, seat: SeatIndex): number {
    return this.ofSeat(gameId, seat).length;
  }

  /** The oldest sockets of `seat` of `gameId` that exceed `MAX_SOCKETS_PER_SEAT` (usually one, right after a new socket attached). */
  beyondCap(gameId: string, seat: SeatIndex): readonly Connection[] {
    const sockets = this.ofSeat(gameId, seat);
    return sockets.slice(0, Math.max(0, sockets.length - MAX_SOCKETS_PER_SEAT));
  }

  seatOnline(gameId: string, seat: SeatIndex): boolean {
    return this.seatCount(gameId, seat) > 0;
  }

  /** Counts one frame from `seat` of `gameId` against the seat's budget; `false` when over it. */
  hit(gameId: string, seat: SeatIndex): boolean {
    const key = `${gameId}/${String(seat)}`;
    const budget = this.budgets.get(key) ?? { limiter: createSocketLimiter({ now: this.now }), lastHitAt: 0 };
    this.budgets.set(key, budget);
    budget.lastHitAt = this.now();
    return budget.limiter.hit();
  }

  /** Forgets the budgets of seats with no open socket whose window has passed. */
  private pruneBudgets(): void {
    const horizon = this.now() - RATE_WINDOW_MS;
    for (const [key, budget] of this.budgets) {
      const [gameId, seat] = key.split("/");
      const online = this.of(gameId).some((c) => String(c.seat) === seat);
      if (!online && budget.lastHitAt < horizon) {
        this.budgets.delete(key);
      }
    }
  }
}
