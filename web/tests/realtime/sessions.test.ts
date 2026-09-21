// SessionRegistry and PrismaSessionStore (plan Task 3) with Prisma mocked
// and Vitest's fake timers; the engine is the real bg-wasm through the Node
// loader (skipped when it is not built, as the session suites are). What is
// checked: a row becomes a session (record, seats, chat, status, idle
// clock), loads are single-flight and never cached on failure, an open seat
// is re-read so the invitee can join, the store writes one guarded update
// per accepted action, finished sessions leave 60 s after the finishing
// write, idle ones 30 min after their last socket, and the 10-minute sweep
// marks games idle for 24 h abandoned and tells the server layer.

import { readFileSync } from "node:fs";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { locateBgWasmPkg, type EngineSync } from "../../src/engine/node";
import type { Record as GameRecord } from "../../src/engine/types";
import { newRecord } from "../../src/game/record";
import type { ChatLine } from "../../src/realtime/protocol";
import { PrismaSessionStore, SessionStoreError, type SessionDb } from "../../src/realtime/session-store";
import {
  ABANDON_AFTER_MS,
  FINISHED_EVICT_MS,
  IDLE_EVICT_MS,
  SWEEP_INTERVAL_MS,
  SessionRegistry,
  type EvictReason,
  type SessionRegistryOptions,
} from "../../src/realtime/sessions";

import { clientMsg, driveSession, sendAccepted } from "./drive";
import { ensureEngine, finishFirstGame, joinBoth } from "./harness";

const T0 = 1_700_000_000_000;
const UPDATED_AT = new Date(T0 - 5_000);

const db = {
  game: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  gameSeat: { findMany: vi.fn() },
  chatMessage: { create: vi.fn() },
};
const asDb = (): SessionDb => db as unknown as SessionDb;

interface SeatRow {
  seat: number;
  guestName: string | null;
  seatSecretHash: string | null;
}

const CLAIMED: SeatRow[] = [
  { seat: 0, guestName: "Alpha", seatSecretHash: "h0" },
  { seat: 1, guestName: "Beta", seatSecretHash: "h1" },
];
const ONE_OPEN: SeatRow[] = [CLAIMED[0], { seat: 1, guestName: null, seatSecretHash: null }];

interface RowOptions {
  id?: string;
  token?: string | null;
  status?: "created" | "active" | "finished" | "abandoned";
  moveLog?: unknown;
  seats?: SeatRow[];
  chat?: { seat: number; text: string; createdAt: Date }[];
  updatedAt?: Date;
}

function gameRow(options: RowOptions = {}) {
  return {
    id: options.id ?? "game_1",
    token: options.token === undefined ? "AAAAAAAAAAAAAAAAAAAAAA" : options.token,
    status: options.status ?? "created",
    moveLog: options.moveLog ?? newRecord(42, 0),
    updatedAt: options.updatedAt ?? UPDATED_AT,
    seats: options.seats ?? ONE_OPEN,
    chat: options.chat ?? [],
  };
}

function fixture(name: string): GameRecord {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as GameRecord;
}

let engine: EngineSync;

interface Made {
  registry: SessionRegistry;
  evicted: [string, EvictReason][];
  abandoned: string[];
  broadcasts: [string, unknown[]][];
}

function make(options: Partial<SessionRegistryOptions> = {}): Made {
  const evicted: [string, EvictReason][] = [];
  const abandoned: string[] = [];
  const broadcasts: [string, unknown[]][] = [];
  const registry = new SessionRegistry({
    db: asDb(),
    engine,
    now: () => Date.now(),
    onEvicted: (gameId, reason) => evicted.push([gameId, reason]),
    onAbandoned: (gameId) => abandoned.push(gameId),
    onBroadcast: (gameId, msgs) => broadcasts.push([gameId, msgs]),
    ...options,
  });
  return { registry, evicted, abandoned, broadcasts };
}

describe.skipIf(locateBgWasmPkg() === null)("SessionRegistry", () => {
  beforeAll(async () => {
    engine = await ensureEngine();
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    for (const fn of [db.game.findUnique, db.game.findMany, db.game.updateMany, db.gameSeat.findMany, db.chatMessage.create]) {
      fn.mockReset();
    }
    db.game.updateMany.mockResolvedValue({ count: 1 });
    db.game.findMany.mockResolvedValue([]);
    db.chatMessage.create.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("loading", () => {
    it("builds a session from the row: record, seats, chat, status and the idle clock", async () => {
      const chat = [
        { seat: 1, text: "second", createdAt: new Date(T0 - 1_000) },
        { seat: 0, text: "first", createdAt: new Date(T0 - 2_000) },
      ];
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED, chat }));
      const { registry } = make();

      const session = await registry.get("game_1");
      expect(session).not.toBeNull();
      expect(db.game.findUnique).toHaveBeenCalledTimes(1);
      expect(db.game.findUnique.mock.calls[0][0]).toMatchObject({ where: { id: "game_1" } });
      expect(session?.record).toEqual(newRecord(42, 0));
      expect(session?.status).toBe("active");
      expect(session?.seats).toEqual([
        { seat: 0, name: "Alpha" },
        { seat: 1, name: "Beta" },
      ]);
      // Oldest first, timestamps as stored, names from the seats.
      expect(session?.chat).toEqual<ChatLine[]>([
        { seat: 0, name: "Alpha", text: "first", at: T0 - 2_000 },
        { seat: 1, name: "Beta", text: "second", at: T0 - 1_000 },
      ]);
      expect(session?.lastActionAt).toBe(UPDATED_AT.getTime());
      expect(registry.peek("game_1")).toBe(session);
      expect(registry.size).toBe(1);
    });

    it("keeps an open seat unnamed and a stored status of abandoned", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "abandoned" }));
      const { registry } = make();
      const session = await registry.get("game_1");
      expect(session?.seats[1]).toEqual({ seat: 1, name: null });
      expect(session?.status).toBe("abandoned");
    });

    it("is null for an unknown id and for a bot game (no invite token)", async () => {
      db.game.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(gameRow({ token: null, status: "finished" }));
      const { registry } = make();
      await expect(registry.get("nope")).resolves.toBeNull();
      await expect(registry.get("game_1")).resolves.toBeNull();
      expect(registry.size).toBe(0);
    });

    it("loads once for concurrent gets and serves the cached session afterwards", async () => {
      let release: (row: unknown) => void = () => undefined;
      db.game.findUnique.mockReturnValue(new Promise((resolve) => (release = resolve)));
      const { registry } = make();

      const first = registry.get("game_1");
      const second = registry.get("game_1");
      release(gameRow({ seats: CLAIMED }));
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(db.game.findUnique).toHaveBeenCalledTimes(1);

      await expect(registry.get("game_1")).resolves.toBe(a);
      expect(db.game.findUnique).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failed load: a malformed record rejects, the next get reads the row again", async () => {
      db.game.findUnique.mockResolvedValueOnce(gameRow({ moveLog: { seed: "x" } })).mockResolvedValueOnce(gameRow({ seats: CLAIMED }));
      const { registry } = make();
      await expect(registry.get("game_1")).rejects.toThrow(/seed/);
      expect(registry.size).toBe(0);
      await expect(registry.get("game_1")).resolves.not.toBeNull();
      expect(db.game.findUnique).toHaveBeenCalledTimes(2);
    });

    it("re-reads the seats while one is open, so the invitee's join draws the opening roll", async () => {
      db.game.findUnique.mockResolvedValue(gameRow());
      db.gameSeat.findMany.mockResolvedValueOnce(ONE_OPEN).mockResolvedValueOnce(CLAIMED);
      const { registry } = make();

      const session = await registry.get("game_1");
      expect(session?.seats[1]).toEqual({ seat: 1, name: null });
      expect(db.gameSeat.findMany).not.toHaveBeenCalled();

      // Still open on the second look.
      await registry.get("game_1");
      expect(db.gameSeat.findMany).toHaveBeenCalledTimes(1);
      expect(db.gameSeat.findMany.mock.calls[0][0]).toMatchObject({ where: { gameId: "game_1" } });
      expect(session?.seats[1]).toEqual({ seat: 1, name: null });

      // Claimed meanwhile by the API route in the other process.
      const again = await registry.get("game_1");
      expect(again).toBe(session);
      expect(session?.seats[1]).toEqual({ seat: 1, name: "Beta" });
      const joined = await session!.handle(1, clientMsg("join"));
      expect(joined.broadcast.map((m) => m.type)).toEqual(["state"]);
      expect(session?.status).toBe("active");
      expect(db.game.updateMany).toHaveBeenCalledTimes(1);

      // Both claimed: no more seat reads.
      await registry.get("game_1");
      expect(db.gameSeat.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("PrismaSessionStore", () => {
    const record = newRecord(42, 0);

    it("writes moveLog and status in one update guarded on a live row", async () => {
      const store = new PrismaSessionStore(asDb(), () => T0);
      await store.saveTurns("game_1", record, "active");
      expect(db.game.updateMany).toHaveBeenCalledTimes(1);
      expect(db.game.updateMany.mock.calls[0][0]).toEqual({
        where: { id: "game_1", status: { in: ["created", "active"] } },
        data: { moveLog: record, status: "active" },
      });
    });

    it("adds result and finishedAt when the game finishes", async () => {
      const store = new PrismaSessionStore(asDb(), () => T0);
      const result = { winner: "white" as const, kind: "gammon" as const, points: 2, score: { white: 2, black: 0 } };
      await store.saveTurns("game_1", record, "finished", result);
      expect(db.game.updateMany.mock.calls[0][0]).toEqual({
        where: { id: "game_1", status: { in: ["created", "active"] } },
        data: { moveLog: record, status: "finished", result, finishedAt: new Date(T0) },
      });
    });

    it("rejects when the row is no longer live (abandoned or finished meanwhile)", async () => {
      db.game.updateMany.mockResolvedValue({ count: 0 });
      const store = new PrismaSessionStore(asDb(), () => T0);
      await expect(store.saveTurns("game_1", record, "active")).rejects.toBeInstanceOf(SessionStoreError);
    });

    it("inserts a ChatMessage with the line's timestamp", async () => {
      const store = new PrismaSessionStore(asDb(), () => T0);
      await store.saveChat("game_1", { seat: 1, name: "Beta", text: "hi", at: T0 - 7 });
      expect(db.chatMessage.create).toHaveBeenCalledWith({ data: { gameId: "game_1", seat: 1, text: "hi", createdAt: new Date(T0 - 7) } });
    });
  });

  describe("eviction", () => {
    it("evicts a session 60 s after the write that finished it, and reloads it on the next get", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED }));
      const { registry, evicted } = make();
      const session = (await registry.get("game_1"))!;
      const lease = (await registry.acquire("game_1"))!;
      await joinBoth(session);
      await driveSession(session, engine);
      expect(session.status).toBe("finished");
      const writes = db.game.updateMany.mock.calls.length;
      expect(writes).toBeGreaterThan(2);
      expect(db.game.updateMany.mock.calls[writes - 1][0]).toMatchObject({ data: { status: "finished" } });

      await vi.advanceTimersByTimeAsync(FINISHED_EVICT_MS - 1);
      expect(registry.peek("game_1")).toBe(session);
      await vi.advanceTimersByTimeAsync(1);
      expect(registry.peek("game_1")).toBeNull();
      expect(evicted).toEqual([["game_1", "finished"]]);
      lease.release(); // late release: a no-op

      const reloaded = await registry.get("game_1");
      expect(reloaded).not.toBe(session);
      expect(db.game.findUnique).toHaveBeenCalledTimes(2);
    });

    it("evicts a row that loads already finished after 60 s", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "finished", moveLog: fixture("finished-record.json"), seats: CLAIMED }));
      const { registry, evicted } = make();
      await registry.get("game_1");
      await vi.advanceTimersByTimeAsync(FINISHED_EVICT_MS);
      expect(evicted).toEqual([["game_1", "finished"]]);
    });

    it("evicts an idle session 30 min after its last socket leaves, never while one is attached", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED }));
      const { registry, evicted } = make();
      const a = (await registry.acquire("game_1"))!;
      const b = (await registry.acquire("game_1"))!;
      expect(b.session).toBe(a.session);

      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS * 2);
      expect(registry.peek("game_1")).toBe(a.session);
      a.release();
      a.release(); // double release counts once
      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS * 2);
      expect(registry.peek("game_1")).toBe(a.session);

      b.release();
      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS - 1);
      expect(registry.peek("game_1")).toBe(a.session);
      // A socket arriving in time cancels the eviction.
      const c = (await registry.acquire("game_1"))!;
      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS);
      expect(registry.peek("game_1")).toBe(a.session);
      c.release();
      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS);
      expect(registry.peek("game_1")).toBeNull();
      expect(evicted).toEqual([["game_1", "idle"]]);
    });

    it("also times out a session that was loaded without a socket", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED }));
      const { registry, evicted } = make();
      await registry.get("game_1");
      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS);
      expect(evicted).toEqual([["game_1", "idle"]]);
    });

    it("acquire is null for an unknown game", async () => {
      db.game.findUnique.mockResolvedValue(null);
      const { registry } = make();
      await expect(registry.acquire("nope")).resolves.toBeNull();
    });

    it("relays a timer-driven broadcast with the game id", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", moveLog: newRecord(7, 3), seats: CLAIMED }));
      const { registry, broadcasts } = make();
      const session = (await registry.get("game_1"))!;
      await joinBoth(session);
      await finishFirstGame(session);
      // A subscriber registered after construction (Task 4's server) hears it too.
      const subscribed: [string, unknown[]][] = [];
      registry.onBroadcast((gameId, msgs) => subscribed.push([gameId, msgs]));
      await sendAccepted(session, 0, clientMsg("nextGame"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.awaitingNextGame).toBe(false);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0][0]).toBe("game_1");
      expect((broadcasts[0][1] as { type: string }[]).map((m) => m.type)).toEqual(["state"]);
      expect(subscribed).toEqual(broadcasts);
    });
  });

  describe("the abandonment sweep", () => {
    it("marks games idle for 24 h abandoned, evicts the ones in memory and tells the server layer", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED, updatedAt: new Date(T0 - ABANDON_AFTER_MS - 60_000) }));
      db.game.findMany.mockResolvedValue([{ id: "game_1" }, { id: "game_9" }]);
      db.game.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      const { registry, evicted, abandoned } = make();
      const subscribed: string[] = [];
      registry.onAbandoned((gameId) => subscribed.push(gameId));
      const session = (await registry.get("game_1"))!;

      await expect(registry.sweep()).resolves.toEqual(["game_1"]);

      const cutoff = new Date(T0 - ABANDON_AFTER_MS);
      expect(db.game.findMany).toHaveBeenCalledWith({
        where: { status: { in: ["created", "active"] }, token: { not: null }, updatedAt: { lt: cutoff } },
        select: { id: true },
      });
      expect(db.game.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: "game_1", status: { in: ["created", "active"] }, updatedAt: { lt: cutoff } },
        data: { status: "abandoned" },
      });
      expect(db.game.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: "game_9", status: { in: ["created", "active"] }, updatedAt: { lt: cutoff } },
        data: { status: "abandoned" },
      });
      expect(evicted).toEqual([["game_1", "abandoned"]]);
      expect(abandoned).toEqual(["game_1"]);
      expect(subscribed).toEqual(["game_1"]);
      expect(registry.peek("game_1")).toBeNull();
      // The evicted session is inert: its timers are gone.
      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS * 2);
      expect(evicted).toHaveLength(1);
      expect(session.status).toBe("active");
    });

    it("evicts a session only once the guarded update changed the row: a losing update leaves session and leases untouched", async () => {
      // The row looked idle when read, but an action landed before the update (`@updatedAt` moved the clock): count 0.
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED, updatedAt: new Date(T0 - ABANDON_AFTER_MS - 60_000) }));
      db.game.findMany.mockResolvedValue([{ id: "game_1" }]);
      db.game.updateMany.mockResolvedValue({ count: 0 });
      const { registry, evicted, abandoned } = make();
      const lease = (await registry.acquire("game_1"))!;

      await expect(registry.sweep()).resolves.toEqual([]);
      expect(db.game.updateMany).toHaveBeenCalledTimes(1);
      expect(evicted).toEqual([]);
      expect(abandoned).toEqual([]);
      expect(registry.peek("game_1")).toBe(lease.session);
      // The lease still counts: no idle eviction while the socket is attached.
      await vi.advanceTimersByTimeAsync(IDLE_EVICT_MS * 2);
      expect(registry.peek("game_1")).toBe(lease.session);
      lease.release();
    });

    it("updates the row before evicting, so an accepted action's write in flight is never orphaned from its session", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED, updatedAt: new Date(T0 - ABANDON_AFTER_MS - 60_000) }));
      db.game.findMany.mockResolvedValue([{ id: "game_1" }]);
      const order: string[] = [];
      db.game.updateMany.mockImplementation(async () => {
        order.push("update");
        return { count: 1 };
      });
      const { registry } = make({ onEvicted: (id, reason) => order.push(`evict:${id}:${reason}`) });
      await registry.get("game_1");
      await expect(registry.sweep()).resolves.toEqual(["game_1"]);
      expect(order).toEqual(["update", "evict:game_1:abandoned"]);
    });

    it("leaves a session alone whose last action is newer than the cutoff (write in flight)", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED, updatedAt: new Date(T0 - 1_000) }));
      db.game.findMany.mockResolvedValue([{ id: "game_1" }]);
      const { registry, abandoned } = make();
      const session = await registry.get("game_1");
      await expect(registry.sweep()).resolves.toEqual([]);
      expect(db.game.updateMany).not.toHaveBeenCalled();
      expect(registry.peek("game_1")).toBe(session);
      expect(abandoned).toEqual([]);
    });

    it("runs every 10 minutes from start() until stop(), which also evicts every session", async () => {
      db.game.findUnique.mockResolvedValue(gameRow({ status: "active", seats: CLAIMED }));
      const { registry, evicted } = make();
      const lease = (await registry.acquire("game_1"))!;
      registry.start();
      registry.start(); // idempotent
      expect(db.game.findMany).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(db.game.findMany).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(db.game.findMany).toHaveBeenCalledTimes(2);

      registry.stop();
      expect(evicted).toEqual([["game_1", "shutdown"]]);
      expect(registry.size).toBe(0);
      lease.release();
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 3);
      expect(db.game.findMany).toHaveBeenCalledTimes(2);
      // Nothing is loaded after stop().
      await expect(registry.get("game_1")).resolves.toBeNull();
    });

    it("keeps sweeping after a database error", async () => {
      db.game.findMany.mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue([]);
      const { registry } = make();
      registry.start();
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
      expect(db.game.findMany).toHaveBeenCalledTimes(2);
      registry.stop();
    });
  });

  it("exposes the plan's timings", () => {
    expect(FINISHED_EVICT_MS).toBe(60_000);
    expect(IDLE_EVICT_MS).toBe(30 * 60_000);
    expect(SWEEP_INTERVAL_MS).toBe(10 * 60_000);
    expect(ABANDON_AFTER_MS).toBe(24 * 60 * 60_000);
  });
});
