// The WebSocket server (plan Task 4) driven with the real `ws` client over
// an ephemeral port: seat authentication and the Origin allowlist at the
// upgrade, the cap on sockets per seat (the oldest closed with 4001), join →
// snapshot, an action acked to
// the sender and broadcast as `state` to both seats, presence on
// connect/close and on a session the registry rebuilt, the frame limit and
// the per-seat rate limit, the heartbeat (on an injected clock), the
// abandonment hook and graceful shutdown. Sessions are real (`GameSession`
// over the wasm engine, from harness.ts); the registry and seat check are
// fakes.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { newRecord } from "../../src/game/record";
import { MAX_SOCKETS_PER_SEAT } from "../../src/realtime/connections";
import { RATE_LIMIT } from "../../src/realtime/limits";
import { createLogger } from "../../src/realtime/log";
import type { ServerMsg } from "../../src/realtime/protocol";
import {
  ABANDONED_CLOSE_CODE,
  TOO_MANY_SOCKETS_CLOSE_CODE,
  createRealtimeServer,
  type RealtimeServer,
  type RealtimeServerOptions,
  type Registry,
  type Session,
  type SessionLease,
} from "../../src/realtime/server";

import { ensureEngine, table, type Table } from "./harness";
import { actorOf, pickPlay, seatOf } from "./pick";
import { Client, connect, httpGet, rawUpgrade } from "./ws-client";

const GAME = "game1";
const SECRETS = ["seat0secretseat0secret", "seat1secretseat1secret"] as const;
const cookieFor = (seat: 0 | 1, secret: string = SECRETS[seat]): string => `bg_seat_${GAME}=${String(seat)}.${secret}`;
const query = `?game=${GAME}`;
const SITE_ORIGIN = "https://backgammon.example";

interface Fixture {
  server: RealtimeServer;
  port: number;
  table: Table;
  /** Makes the fake registry answer with another session from now on (a rebuild after eviction). */
  swapSession: (next: Session) => void;
  abandoned: ((gameId: string) => void)[];
  broadcasts: ((gameId: string, msgs: ServerMsg[]) => void)[];
  stop: ReturnType<typeof vi.fn>;
  logLines: string[];
  health: { fail: boolean };
  /** Leases handed out by the fake registry and not yet released. */
  leases: { open: number; total: number };
}

const fixtures: Fixture[] = [];

async function start(options: Partial<RealtimeServerOptions> = {}, tableSeed = 7): Promise<Fixture> {
  const t = table(newRecord(tableSeed, 0));
  const abandoned: Fixture["abandoned"] = [];
  const broadcasts: Fixture["broadcasts"] = [];
  const stop = vi.fn();
  const logLines: string[] = [];
  const health = { fail: false };
  const leases = { open: 0, total: 0 };
  let current: Session = t.session;
  const sessionOf = (gameId: string): Session | null => (gameId === GAME ? current : null);
  const registry: Registry = {
    get: (gameId: string): Promise<Session | null> => Promise.resolve(sessionOf(gameId)),
    acquire: (gameId: string): Promise<SessionLease | null> => {
      const session = sessionOf(gameId);
      if (session === null) {
        return Promise.resolve(null);
      }
      leases.open += 1;
      leases.total += 1;
      let released = false;
      return Promise.resolve({
        session,
        release: () => {
          if (!released) {
            released = true;
            leases.open -= 1;
          }
        },
      });
    },
    onAbandoned: (cb) => {
      abandoned.push(cb);
    },
    onBroadcast: (cb) => {
      broadcasts.push(cb);
    },
    stop,
  };
  const server = createRealtimeServer({
    registry,
    // Game-agnostic on purpose: an unknown game must reach the registry (404), not stop at the seat check.
    verifySeat: (_gameId, seat, secret) => Promise.resolve(secret === SECRETS[seat]),
    healthCheck: () => (health.fail ? Promise.reject(new Error("db down")) : Promise.resolve()),
    log: createLogger({ level: "debug", write: (line) => logLines.push(line) }),
    // Development policy: the test clients send no Origin.
    origins: { allowed: [SITE_ORIGIN], allowMissing: true },
    ...options,
  });
  const { port } = await server.listen(0, "127.0.0.1");
  const fixture: Fixture = {
    server,
    port,
    table: t,
    swapSession: (next) => {
      current = next;
    },
    abandoned,
    broadcasts,
    stop,
    logLines,
    health,
    leases,
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.server.shutdown();
  }
});

async function joinBoth(port: number): Promise<[Client, Client]> {
  const a = await connect(port, cookieFor(0), query);
  a.send({ id: "ja", type: "join" });
  await a.next("ack");
  // The table has both seats claimed, so the first join drew the opening roll and broadcast it to the only socket.
  await a.next("state");
  const b = await connect(port, cookieFor(1), query);
  b.send({ id: "jb", type: "join" });
  await b.next("ack");
  // Drop the presence frames of the two connections; tests start from empty inboxes.
  a.inbox.splice(0);
  b.inbox.splice(0);
  return [a, b];
}

beforeAll(async () => {
  await ensureEngine();
});

describe("http", () => {
  it("GET /healthz is 200 while the check passes and 503 once it fails", async () => {
    const f = await start();
    expect(await httpGet(f.port, "/healthz")).toEqual({ status: 200, body: JSON.stringify({ status: "ok" }) });
    f.health.fail = true;
    const down = await httpGet(f.port, "/healthz");
    expect(down.status).toBe(503);
    expect(JSON.parse(down.body)).toEqual({ status: "error" });
  });

  it("answers anything else with 404", async () => {
    const f = await start();
    expect((await httpGet(f.port, "/")).status).toBe(404);
    expect((await httpGet(f.port, "/ws")).status).toBe(404);
  });
});

describe("upgrade", () => {
  it("refuses a socket without a seat cookie with 401", async () => {
    const f = await start();
    await expect(connect(f.port, null, query)).rejects.toThrow("status 401");
  });

  it("refuses a wrong secret with 401", async () => {
    const f = await start();
    await expect(connect(f.port, cookieFor(0, "wrongsecretwrongsecret"), query)).rejects.toThrow("status 401");
  });

  it("refuses a missing game query with 400 and a game the registry does not know with 404", async () => {
    const f = await start();
    await expect(connect(f.port, cookieFor(0), "")).rejects.toThrow("status 400");
    await expect(connect(f.port, `bg_seat_other=0.${SECRETS[0]}`, "?game=other")).rejects.toThrow("status 404");
    expect(f.leases.total).toBe(0);
  });

  it("releases the lease when the handshake aborts after the seat was verified", async () => {
    const f = await start();
    const status = await rawUpgrade(f.port, `/ws${query}`, { cookie: cookieFor(0), "sec-websocket-version": "7" });
    expect(status).toBe(400);
    expect(f.leases.total).toBe(1);
    await vi.waitFor(() => expect(f.leases.open).toBe(0));
  });

  it("answers 500 when the seat check itself fails", async () => {
    const f = await start({ verifySeat: () => Promise.reject(new Error("db down")) });
    await expect(connect(f.port, cookieFor(0), query)).rejects.toThrow("status 500");
  });

  it("refuses a browser Origin outside the allowlist with 403 and lets a listed origin and, in development, no Origin through", async () => {
    const f = await start();
    const upgrade = (headers: { [key: string]: string }) => rawUpgrade(f.port, `/ws${query}`, { cookie: cookieFor(0), ...headers });
    expect(await upgrade({ origin: SITE_ORIGIN })).toBe(101);
    expect(await upgrade({})).toBe(101);
    // A same-site sibling, another scheme, an opaque origin, an unlisted localhost: all refused before the seat is even checked.
    expect(await upgrade({ origin: "https://time.backgammon.example" })).toBe(403);
    expect(await upgrade({ origin: "http://backgammon.example" })).toBe(403);
    expect(await upgrade({ origin: "null" })).toBe(403);
    expect(await upgrade({ origin: "http://localhost:3000" })).toBe(403);
    expect(f.leases.total).toBe(2);
    await vi.waitFor(() => expect(f.leases.open).toBe(0));
  });

  it("in production a handshake without Origin is refused with 403 too; a second listed origin is accepted", async () => {
    const f = await start({ origins: { allowed: [SITE_ORIGIN, "http://localhost:3000"], allowMissing: false } });
    const upgrade = (headers: { [key: string]: string }) => rawUpgrade(f.port, `/ws${query}`, { cookie: cookieFor(0), ...headers });
    expect(await upgrade({})).toBe(403);
    expect(await upgrade({ origin: "http://localhost:3000" })).toBe(101);
    expect(await upgrade({ origin: "http://localhost:3001" })).toBe(403);
    expect(await upgrade({ origin: SITE_ORIGIN })).toBe(101);
    expect(f.leases.total).toBe(2);
    await vi.waitFor(() => expect(f.leases.open).toBe(0));
  });

  it("caps the open sockets of a seat at four: the fifth closes the oldest with 4001", async () => {
    const f = await start();
    expect(MAX_SOCKETS_PER_SEAT).toBe(4);
    const open: Client[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_SEAT; i++) {
      open.push(await connect(f.port, cookieFor(0), query));
    }
    // The other seat has its own allowance.
    const other = await connect(f.port, cookieFor(1), query);
    const fifth = await connect(f.port, cookieFor(0), query);
    expect(await open[0].closed).toEqual({ code: TOO_MANY_SOCKETS_CLOSE_CODE, reason: "too many connections" });
    expect(TOO_MANY_SOCKETS_CLOSE_CODE).toBe(4001);
    // The newest socket and the other three of the seat stay open; the seat never went offline.
    fifth.send({ id: "p", type: "ping" });
    await fifth.next("pong");
    for (const c of [...open.slice(1), fifth, other]) {
      expect(c.ws.readyState).toBe(WebSocket.OPEN);
    }
    expect(other.inbox.filter((m) => m.type === "presence").every((m) => m.type === "presence" && m.presence[0])).toBe(true);
    await vi.waitFor(() => expect(f.leases).toEqual({ open: MAX_SOCKETS_PER_SEAT + 1, total: MAX_SOCKETS_PER_SEAT + 2 }));
    // A sixth closes the next oldest, and only that one.
    const sixth = await connect(f.port, cookieFor(0), query);
    expect((await open[1].closed).code).toBe(TOO_MANY_SOCKETS_CLOSE_CODE);
    expect(open[2].ws.readyState).toBe(WebSocket.OPEN);
    sixth.ws.close();
  });

  it("refuses a path other than /ws with 404", async () => {
    const f = await start();
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${String(f.port)}/other?game=${GAME}`, { headers: { cookie: cookieFor(0) } });
        ws.on("unexpected-response", (_req, res) => reject(new Error(`status ${String(res.statusCode)}`)));
        ws.on("error", reject);
        ws.on("open", resolve);
      }),
    ).rejects.toThrow("status 404");
  });
});

describe("messages", () => {
  it("join answers a snapshot for the socket's seat, then the ack", async () => {
    const f = await start();
    const a = await connect(f.port, cookieFor(1), query);
    a.send({ id: "j1", type: "join" });
    const snapshot = await a.next("snapshot");
    expect(snapshot.game.id).toBe(GAME);
    expect(snapshot.game.seat).toBe(1);
    expect(snapshot.game.presence).toEqual([false, true]);
    expect(await a.next("ack")).toEqual({ type: "ack", id: "j1" });
    // Both seats being claimed, the join drew the opening roll and broadcast it (after the reply).
    expect((await a.next("state")).lastTurnIndex).toBe(0);
    // Left over: only the presence broadcast of its own connection, which preceded the snapshot.
    expect(a.inbox).toEqual([{ type: "presence", presence: [false, true] }]);
  });

  it("an accepted action is acked to the sender and broadcast as state to both seats", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    const engine = await ensureEngine();
    const game = f.table.session.match.game;
    const actor = actorOf(game);
    if (actor === null) {
      throw new Error("nobody to act");
    }
    const [mover, other] = seatOf(actor) === 0 ? [a, b] : [b, a];
    const msg = game.phase === "toRoll" ? { id: "act", type: "roll" } : { id: "act", type: "move", play: pickPlay(engine, game) };
    mover.send(msg);
    expect(await mover.next("ack")).toEqual({ type: "ack", id: "act" });
    const [stateMover, stateOther] = await Promise.all([mover.next("state"), other.next("state")]);
    expect(stateMover).toEqual(stateOther);
    expect(stateMover.record.turns.length).toBe(f.table.session.record.turns.length);
    expect(other.inbox.filter((m) => m.type === "ack")).toEqual([]);
  });

  it("a rejected action goes to the sender only", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    const game = f.table.session.match.game;
    const actor = actorOf(game);
    if (actor === null) {
      throw new Error("nobody to act");
    }
    const idle = seatOf(actor) === 0 ? b : a;
    idle.send({ id: "r1", type: "roll" });
    const rejected = await idle.next("rejected");
    expect(rejected.id).toBe("r1");
    expect(rejected.code).toBe("notYourTurn");
    idle.send({ id: "p", type: "ping" });
    await idle.next("pong");
    expect(a.inbox.concat(b.inbox).filter((m) => m.type === "state")).toEqual([]);
  });

  it("chat is acked and broadcast to both", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    a.send({ id: "c1", type: "chat", text: "  hello  " });
    expect(await a.next("ack")).toEqual({ type: "ack", id: "c1" });
    const [la, lb] = await Promise.all([a.next("chat"), b.next("chat")]);
    expect(la).toEqual(lb);
    expect(la.line).toMatchObject({ seat: 0, text: "hello" });
  });

  it("a frame that does not parse is rejected as invalid, keeping its id when usable", async () => {
    const f = await start();
    const a = await connect(f.port, cookieFor(0), query);
    a.ws.send("not json");
    expect(await a.next("rejected")).toMatchObject({ id: "", code: "invalid" });
    a.send({ id: "x9", type: "teleport" });
    expect(await a.next("rejected")).toMatchObject({ id: "x9", code: "invalid" });
  });

  it("ping is answered with pong", async () => {
    const f = await start();
    const a = await connect(f.port, cookieFor(0), query);
    a.send({ id: "p1", type: "ping" });
    expect(await a.next("pong")).toEqual({ type: "pong" });
  });
});

describe("presence", () => {
  it("broadcasts presence when a seat connects and when its last socket closes", async () => {
    const f = await start();
    const a = await connect(f.port, cookieFor(0), query);
    expect(await a.next("presence")).toEqual({ type: "presence", presence: [true, false] });
    const b = await connect(f.port, cookieFor(1), query);
    expect(await a.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    expect(await b.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    const b2 = await connect(f.port, cookieFor(1), query);
    expect(await a.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    b.ws.close();
    await b.closed;
    b2.send({ id: "p", type: "ping" });
    await b2.next("pong");
    expect(a.inbox.filter((m) => m.type === "presence")).toEqual([]);
    b2.ws.close();
    expect(await a.next("presence")).toEqual({ type: "presence", presence: [true, false] });
    expect(f.leases).toEqual({ open: 1, total: 3 });
    a.ws.close();
    await a.closed;
    await vi.waitFor(() => expect(f.leases.open).toBe(0));
  });

  it("re-syncs both seats' presence on a session the registry rebuilt", async () => {
    const f = await start();
    const a = await connect(f.port, cookieFor(0), query);
    await a.next("presence");
    // Simulate a finished-and-evicted session rebuilt from the row: it starts with nobody online.
    f.table.session.setPresence(0, false);
    const b = await connect(f.port, cookieFor(1), query);
    expect(await b.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    expect(await a.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    b.send({ id: "j", type: "join" });
    expect((await b.next("snapshot")).game.presence).toEqual([true, true]);
  });

  it("corrects the presence of a session rebuilt between two frames of an open socket, once", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    // The registry evicted the finished session and rebuilds it from the row on the next frame: nobody is online in it.
    const rebuilt = table(newRecord(7, 0));
    expect(rebuilt.session.presence).toEqual([false, false]);
    f.swapSession(rebuilt.session);
    a.send({ id: "j2", type: "join" });
    expect((await a.next("snapshot")).game.presence).toEqual([true, true]);
    expect(rebuilt.session.presence).toEqual([true, true]);
    expect(await a.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    expect(await b.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    // A further frame on the same session broadcasts nothing more.
    b.send({ id: "p", type: "ping" });
    await b.next("pong");
    expect(a.inbox.concat(b.inbox).filter((m) => m.type === "presence")).toEqual([]);
  });
});

describe("limits", () => {
  it("closes a socket that sends a frame over 8 KiB with 1009", async () => {
    const f = await start();
    const a = await connect(f.port, cookieFor(0), query);
    a.ws.send(JSON.stringify({ id: "big", type: "chat", text: "x".repeat(9000) }));
    expect((await a.closed).code).toBe(1009);
  });

  it("rejects the 21st message within 10 s as rateLimited", async () => {
    const f = await start();
    const a = await connect(f.port, cookieFor(0), query);
    for (let i = 0; i < RATE_LIMIT; i++) {
      a.send({ id: `p${String(i)}`, type: "ping" });
    }
    for (let i = 0; i < RATE_LIMIT; i++) {
      await a.next("pong");
    }
    a.send({ id: "p20", type: "ping" });
    expect(await a.next("rejected")).toMatchObject({ id: "p20", code: "rateLimited" });
    expect(a.inbox.filter((m) => m.type === "pong")).toEqual([]);
  });

  it("shares one budget between all sockets of a seat, and none with the other seat", async () => {
    const f = await start();
    const a1 = await connect(f.port, cookieFor(0), query);
    const a2 = await connect(f.port, cookieFor(0), query);
    const b = await connect(f.port, cookieFor(1), query);
    for (let i = 0; i < RATE_LIMIT / 2; i++) {
      a1.send({ id: `x${String(i)}`, type: "ping" });
      a2.send({ id: `y${String(i)}`, type: "ping" });
    }
    for (let i = 0; i < RATE_LIMIT / 2; i++) {
      await a1.next("pong");
      await a2.next("pong");
    }
    a2.send({ id: "over", type: "ping" });
    expect(await a2.next("rejected")).toMatchObject({ id: "over", code: "rateLimited" });
    a1.send({ id: "over1", type: "ping" });
    expect(await a1.next("rejected")).toMatchObject({ id: "over1", code: "rateLimited" });
    b.send({ id: "fine", type: "ping" });
    expect(await b.next("pong")).toEqual({ type: "pong" });
  });
});

describe("failures", () => {
  it("closes the socket with 1011 when the session cannot persist, and logs it", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    const engine = await ensureEngine();
    const game = f.table.session.match.game;
    const actor = actorOf(game);
    if (actor === null) {
      throw new Error("nobody to act");
    }
    const mover = seatOf(actor) === 0 ? a : b;
    f.table.store.failNext = new Error("disk full");
    const msg = game.phase === "toRoll" ? { id: "act", type: "roll" } : { id: "act", type: "move", play: pickPlay(engine, game) };
    mover.send(msg);
    expect((await mover.closed).code).toBe(1011);
    const errors = f.logLines.map((l) => JSON.parse(l) as { level: string; msg: string; error?: { message: string } }).filter((l) => l.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].error?.message).toBe("disk full");
  });

  it("closes every socket of an abandoned game", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    expect(f.abandoned).toHaveLength(1);
    f.abandoned[0]("other");
    a.send({ id: "p", type: "ping" });
    await a.next("pong");
    f.abandoned[0](GAME);
    const [ca, cb] = await Promise.all([a.closed, b.closed]);
    expect(ca.code).toBe(ABANDONED_CLOSE_CODE);
    expect(cb.code).toBe(ABANDONED_CLOSE_CODE);
  });

  it("delivers a registry broadcast to every socket of the game", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    expect(f.broadcasts).toHaveLength(1);
    f.broadcasts[0]("other", [{ type: "presence", presence: [false, false] }]);
    f.broadcasts[0](GAME, [{ type: "presence", presence: [true, true] }]);
    expect(await a.next("presence")).toEqual({ type: "presence", presence: [true, true] });
    expect(await b.next("presence")).toEqual({ type: "presence", presence: [true, true] });
  });
});

describe("heartbeat", () => {
  it("terminates a socket silent for longer than the timeout, on the server's clock", async () => {
    // The clock is injected and never moves on its own, so no wall-clock stall can make the alive socket look silent.
    const clock = { now: 1_700_000_000_000 };
    const timeoutMs = 30_000;
    const f = await start({ heartbeat: { intervalMs: 20, timeoutMs }, now: () => clock.now });
    const dead = await connect(f.port, cookieFor(0), query, { autoPong: false });
    // Past the deadline for anything seen so far; the socket connecting now is fresh.
    clock.now += timeoutMs + 1;
    const alive = await connect(f.port, cookieFor(1), query);
    const pinged = new Promise<void>((resolve) => alive.ws.once("ping", () => resolve()));
    expect((await dead.closed).code).toBe(1006);
    await pinged;
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    // Whether the dead socket was terminated before or after the alive one connected, the last word is "seat 1 only".
    let presence = (await alive.next("presence")).presence;
    if (presence[0]) {
      presence = (await alive.next("presence")).presence;
    }
    expect(presence).toEqual([false, true]);
  });
});

describe("shutdown", () => {
  it("closes every socket with 1001, stops the registry and the listener", async () => {
    const f = await start();
    const [a, b] = await joinBoth(f.port);
    await f.server.shutdown();
    expect((await a.closed).code).toBe(1001);
    expect((await b.closed).code).toBe(1001);
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.leases.open).toBe(0);
    await expect(httpGet(f.port, "/healthz")).rejects.toThrow();
    // A second shutdown is a no-op.
    await f.server.shutdown();
  });
});
