// SessionRegistry against a real PostgreSQL (plan Task 3): an invite made by
// `createInvite`, claimed by `claimSeat`, is loaded into a session, both
// seats join (opening roll), two turns are played and a chat line sent; a
// fresh registry then reloads the game from the row and must see exactly
// the same record, match state, seats, chat and idle clock. A game driven
// to its end is stored like a bot game (`getGame` reads it for the review
// page); the sweep marks a game idle for 25 h abandoned; and a session whose
// row was abandoned meanwhile cannot write to it. Runs only when
// DATABASE_URL is set and bg-wasm is built; skipped otherwise.
//
//   docker compose -f web/docker-compose.dev.yml up -d --wait
//   export DATABASE_URL=postgresql://backgammon:dev@127.0.0.1:5439/backgammon
//   pnpm --filter web prisma:migrate:deploy
//   pnpm --filter web test tests/realtime/sessions.integration.test.ts
//
// Every row it creates is deleted again in `afterAll`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { locateBgWasmPkg, type EngineSync } from "../../src/engine/node";
import { ABANDON_AFTER_MS, FINISHED_EVICT_MS, SessionRegistry, type EvictReason } from "../../src/realtime/sessions";
import { disconnectDb, getDb } from "../../src/server/db";
import { getGame } from "../../src/server/games";
import { claimSeat, createInvite } from "../../src/server/invites";

import { clientMsg, driveSession, pickPlay, sendAccepted } from "./drive";
import { ensureEngine, FakeTimer, joinBoth } from "./harness";

const enabled = Boolean(process.env.DATABASE_URL) && locateBgWasmPkg() !== null;

// Under CI a skip would hide a missing database or an unbuilt engine: the `web` job provides both.
if (!enabled && process.env.CI) {
  throw new Error("sessions.integration: DATABASE_URL is not set or engine/bg-wasm/pkg is not built; CI must provide both (see .github/workflows/ci.yml)");
}

let engine: EngineSync;

/** An invite with both seats claimed; returns the game id. */
async function claimedGame(format: "single" | "match", matchLength: number): Promise<string> {
  const invite = await createInvite({ format, matchLength, creatorSide: "white", creatorName: "Host" });
  const claimed = await claimSeat({ token: invite.token, name: "Guest" });
  if (typeof claimed === "string") {
    throw new Error(`claim failed: ${claimed}`);
  }
  return invite.gameId;
}

describe.skipIf(!enabled)("SessionRegistry against PostgreSQL (DATABASE_URL set)", () => {
  const created: string[] = [];
  const registries: SessionRegistry[] = [];

  function registry(options: { onEvicted?: (gameId: string, reason: EvictReason) => void; onAbandoned?: (gameId: string) => void } = {}): SessionRegistry {
    const r = new SessionRegistry({ db: getDb(), engine, timer: new FakeTimer(), ...options });
    registries.push(r);
    return r;
  }

  beforeAll(async () => {
    engine = await ensureEngine();
    // Fail with a clear message when the migrations have not been applied.
    await getDb().chatMessage.count();
  });

  afterAll(async () => {
    for (const r of registries) {
      r.stop();
    }
    if (created.length > 0) {
      await getDb().game.deleteMany({ where: { id: { in: created } } });
    }
    await disconnectDb();
  });

  it("plays two turns and reloads the identical session from the row", async () => {
    const gameId = await claimedGame("match", 3);
    created.push(gameId);

    const first = registry();
    const session = (await first.get(gameId))!;
    expect(session.status).toBe("active");
    expect(session.seats).toEqual([
      { seat: 0, name: "Host" },
      { seat: 1, name: "Guest" },
    ]);
    expect(session.record.turns).toEqual([]);

    // Both join: the opening roll is drawn and written.
    await joinBoth(session);
    expect(session.record.turns).toHaveLength(1);
    const mover = session.match.game.onRoll!;
    const moverSeat = mover === "white" ? 0 : 1;
    const other = moverSeat === 0 ? 1 : 0;

    // Every accepted action moves `updatedAt` (the sweep's clock) — Prisma's `@updatedAt` on the guarded `updateMany`.
    const before = (await getDb().game.findUniqueOrThrow({ where: { id: gameId }, select: { updatedAt: true } })).updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Turn one: the opening mover plays; turn two: the opponent rolls and plays.
    await sendAccepted(session, moverSeat, clientMsg("move", { play: pickPlay(engine, session.match.game) }));
    const after = (await getDb().game.findUniqueOrThrow({ where: { id: gameId }, select: { updatedAt: true } })).updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    await sendAccepted(session, other, clientMsg("roll"));
    if (session.match.game.phase === "toMove") {
      await sendAccepted(session, other, clientMsg("move", { play: pickPlay(engine, session.match.game) }));
    }
    await sendAccepted(session, other, clientMsg("chat", { text: "good luck" }));
    expect(session.record.turns.length).toBeGreaterThanOrEqual(3);

    const row = await getDb().game.findUniqueOrThrow({ where: { id: gameId } });
    expect(row.status).toBe("active");
    expect(row.moveLog).toEqual(session.record);
    expect(row.result).toBeNull();
    expect(row.finishedAt).toBeNull();
    expect(await getDb().chatMessage.count({ where: { gameId } })).toBe(1);

    // A restart: a fresh registry sees the same game.
    first.evict(gameId, "shutdown");
    const second = registry();
    const resumed = (await second.get(gameId))!;
    expect(resumed).not.toBe(session);
    expect(resumed.record).toEqual(session.record);
    expect(resumed.match).toEqual(session.match);
    expect(resumed.status).toBe("active");
    expect(resumed.seats).toEqual(session.seats);
    expect(resumed.chat).toEqual(session.chat);
    expect(resumed.awaitingNextGame).toBe(false);
    expect(resumed.lastActionAt).toBe(row.updatedAt.getTime());
    expect(engine.replay(resumed.record)).toEqual(resumed.match);

    // And play goes on from where it stopped: the dice stream is in step.
    const actor = resumed.match.game.onRoll!;
    const seat = actor === "white" ? 0 : 1;
    if (resumed.match.game.phase === "toRoll") {
      await sendAccepted(resumed, seat, clientMsg("roll"));
    }
    expect(engine.replay(resumed.record)).toEqual(resumed.match);
  });

  it("stores a finished game like a bot game, so getGame reads it for the review page", async () => {
    const gameId = await claimedGame("single", 0);
    created.push(gameId);
    const evicted: [string, EvictReason][] = [];
    const timer = new FakeTimer();
    const r = new SessionRegistry({ db: getDb(), engine, timer, onEvicted: (id, reason) => evicted.push([id, reason]) });
    registries.push(r);

    const session = (await r.get(gameId))!;
    await joinBoth(session);
    const drive = await driveSession(session, engine);
    expect(session.status).toBe("finished");
    expect(drive.gameOvers).toHaveLength(1);

    const stored = await getGame(gameId);
    expect(stored).toMatchObject({
      id: gameId,
      format: "single",
      matchLength: 0,
      botLevel: null,
      status: "finished",
      record: session.record,
      result: { ...session.match.game.result, score: session.match.score },
      seats: { white: { kind: "guest", name: "Host" }, black: { kind: "guest", name: "Guest" } },
    });
    expect(stored?.finishedAt).toBeInstanceOf(Date);

    // The finishing write armed the 60 s eviction (next to the 30 min idle timer armed at load).
    const finish = timer.pending.find((t) => t.ms === FINISHED_EVICT_MS);
    expect(finish).toBeDefined();
    timer.clear(finish);
    finish!.fn();
    expect(evicted).toContainEqual([gameId, "finished"]);
    expect(r.peek(gameId)).toBeNull();

    // Reloaded, it is read-only.
    const again = (await r.get(gameId))!;
    expect(again.status).toBe("finished");
    const refused = await again.handle(0, clientMsg("roll"));
    expect(refused.reply[0]).toMatchObject({ type: "rejected", code: "gameOver" });
  });

  it("the sweep abandons a game idle for more than 24 h and leaves fresh ones alone", async () => {
    const stale = await claimedGame("single", 0);
    const fresh = await claimedGame("single", 0);
    created.push(stale, fresh);
    await getDb().game.update({ where: { id: stale }, data: { updatedAt: new Date(Date.now() - ABANDON_AFTER_MS - 3_600_000) } });

    const abandoned: string[] = [];
    const r = registry({ onAbandoned: (id) => abandoned.push(id) });
    const live = (await r.get(stale))!;
    expect(live.status).toBe("active");

    const swept = await r.sweep();
    expect(swept).toContain(stale);
    expect(swept).not.toContain(fresh);
    expect(abandoned).toContain(stale);
    expect(r.peek(stale)).toBeNull();

    const rows = await getDb().game.findMany({ where: { id: { in: [stale, fresh] } }, select: { id: true, status: true } });
    expect(rows.find((g) => g.id === stale)?.status).toBe("abandoned");
    expect(rows.find((g) => g.id === fresh)?.status).toBe("active");

    const reloaded = (await r.get(stale))!;
    expect(reloaded.status).toBe("abandoned");
    const refused = await reloaded.handle(0, clientMsg("roll"));
    expect(refused.reply[0]).toMatchObject({ type: "rejected", code: "gameOver" });
  });

  it("a session whose row was abandoned meanwhile cannot write to it", async () => {
    const gameId = await claimedGame("single", 0);
    created.push(gameId);
    const r = registry();
    const session = (await r.get(gameId))!;
    await joinBoth(session);
    const before = session.record;

    await getDb().game.update({ where: { id: gameId }, data: { status: "abandoned" } });
    const seat = session.match.game.onRoll === "white" ? 0 : 1;
    await expect(session.handle(seat, clientMsg("move", { play: pickPlay(engine, session.match.game) }))).rejects.toThrow(/not live|abandoned|no longer/);
    expect(session.record).toBe(before);
    const row = await getDb().game.findUniqueOrThrow({ where: { id: gameId } });
    expect(row.status).toBe("abandoned");
    expect(row.moveLog).toEqual(before);
  });
});
