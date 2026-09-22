// GameSession against the real engine (bg-wasm through the Node loader):
// the authoritative in-memory game behind the realtime server (plan Task 2).
// Two scripted seats play a seeded money game through `handle`; the record
// the session builds must replay with the engine to exactly the state it
// reports and be what the store was last given. The reject matrix of the
// plan is checked action by action, plus the opening roll on join,
// server-side forfeits, chat, presence and the idle clock. Match play and
// resuming live in session-match.test.ts. Skipped when engine/bg-wasm/pkg
// is not built (fails under CI like the parity suite).

import { beforeAll, describe, expect, it } from "vitest";

import { locateBgWasmPkg, type EngineSync } from "../../src/engine/node";
import { newRecord } from "../../src/game/record";
import { MAX_CHAT_LENGTH, parseClientMsg, type ChatLine } from "../../src/realtime/protocol";
import { toWireRecord } from "../../src/realtime/protocol-engine";

import { clientMsg, driveSession, sendAccepted } from "./drive";
import { ensureEngine, expectRejected, joinBoth, playUntilTurnOf, resignAccepted, snapshotOf, table } from "./harness";

let engine: EngineSync;

describe.skipIf(locateBgWasmPkg() === null)("GameSession", () => {
  beforeAll(async () => {
    engine = await ensureEngine();
  });

  describe("join and the opening roll", () => {
    it("answers join with a snapshot and draws the opening roll once both seats are claimed", async () => {
      const { session, store } = table(newRecord(42, 0), { seats: [{ seat: 0, name: "Alpha" }, { seat: 1, name: null }] });
      expect(session.status).toBe("created");

      const alone = await session.handle(0, clientMsg("join"));
      expect(alone.broadcast).toEqual([]);
      expect(alone.reply.map((m) => m.type)).toEqual(["snapshot", "ack"]);
      const snap = snapshotOf(alone.reply);
      expect(snap).toMatchObject({ id: "game1", seat: 0, awaitingNextGame: false, presence: [false, false], chat: [] });
      expect(snap.record.turns).toEqual([]);
      expect(snap.match.game.phase).toBe("openingRoll");
      expect(snap.seats).toEqual([
        { seat: 0, name: "Alpha" },
        { seat: 1, name: null },
      ]);
      expect(store.turns).toEqual([]);
      // Nothing can be played until the opponent is there.
      await expectRejected(session, 0, clientMsg("roll"), "wrongPhase");

      session.setSeat(1, { seat: 1, name: "Beta" });
      const joined = await session.handle(1, clientMsg("join"));
      const second = snapshotOf(joined.reply);
      expect(second.seat).toBe(1);
      expect(second.record.turns).toEqual([
        { player: "white", dice: { hi: 5, lo: 1 }, action: "roll", play: null, resignPoints: null },
      ]);
      expect(second.match.game).toMatchObject({ phase: "toMove", onRoll: "white", dice: { hi: 5, lo: 1 } });
      // The seat already at the table learns of the roll too, and it is on disk before anyone hears of it.
      expect(joined.broadcast).toEqual([{ type: "state", record: second.record, match: second.match, awaitingNextGame: false, lastTurnIndex: 0 }]);
      expect(store.turns).toHaveLength(1);
      expect(store.turns[0]).toMatchObject({ gameId: "game1", status: "active", result: null });
      // The store gets the full record; the wire gets it without the seed.
      expect(store.turns[0].record).toEqual(session.record);
      expect(second.record).toEqual(toWireRecord(session.record, false));
      expect(session.status).toBe("active");

      // A second join (reconnect) draws nothing new.
      const again = await session.handle(0, clientMsg("join"));
      expect(again.broadcast).toEqual([]);
      expect(snapshotOf(again.reply).record).toEqual(second.record);
      expect(store.turns).toHaveLength(1);
    });

    it("answers ping with pong and tracks presence", async () => {
      const { session } = table(newRecord(42, 0));
      const pinged = await session.handle(1, clientMsg("ping"));
      expect(pinged).toEqual({ reply: [{ type: "pong" }], broadcast: [] });
      expect(session.setPresence(1, true)).toEqual([{ type: "presence", presence: [false, true] }]);
      expect(session.setPresence(0, true)).toEqual([{ type: "presence", presence: [true, true] }]);
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply).presence).toEqual([true, true]);
      expect(session.setPresence(1, false)).toEqual([{ type: "presence", presence: [true, false] }]);
    });
  });

  describe("a seeded money game", () => {
    it("plays to the end; the record replays to the reported state and is what the store was given", async () => {
      const { session, store } = table(newRecord(42, 0));
      await joinBoth(session);
      const log = await driveSession(session, engine);

      expect(session.status).toBe("finished");
      expect(session.match.game.phase).toBe("finished");
      expect(log.gameOvers).toHaveLength(1);
      expect(log.gameOvers[0]).toEqual({ type: "gameOver", result: session.match.game.result, matchOver: true });
      expect(log.actions.length).toBeGreaterThan(10);
      // Every accepted action produced exactly one state broadcast with the new last turn index.
      expect(log.states).toHaveLength(log.actions.length);
      expect(log.states.at(-1)?.lastTurnIndex).toBe(session.record.turns.length - 1);

      const record = session.record;
      expect(engine.replay(record)).toEqual(session.match);
      const moves = record.turns.filter((t) => t.action === "move");
      const rolls = record.turns.filter((t) => t.action === "roll");
      expect(moves).toHaveLength(rolls.length);

      // Persistence: one save per accepted action (plus the opening roll), the last one finished with the result.
      expect(store.turns).toHaveLength(log.actions.length + 1);
      expect(store.turns.every((t) => t.gameId === "game1")).toBe(true);
      expect(store.turns.slice(0, -1).every((t) => t.status === "active" && t.result === null)).toBe(true);
      const last = store.turns.at(-1)!;
      expect(last.record).toEqual(record);
      expect(last.status).toBe("finished");
      expect(last.result).toEqual({ ...session.match.game.result, score: session.match.score });

      // Nothing more can be played, but the players may still talk.
      await expectRejected(session, 0, clientMsg("roll"), "gameOver");
      await expectRejected(session, 1, clientMsg("resign", { kind: "single" }), "gameOver");
      await expectRejected(session, 1, clientMsg("acceptResign"), "gameOver");
      const chat = await session.handle(1, clientMsg("chat", { text: "gg" }));
      expect(chat.broadcast).toEqual([{ type: "chat", line: { seat: 1, name: "Beta", text: "gg", at: expect.any(Number) } }]);
    }, 60_000);

    it("forfeits a turn with no legal move itself, in the same action as the roll", async () => {
      // Seed 31 played first-legal-play by both sides blocks the mover several times.
      const { session } = table(newRecord(31, 0));
      await joinBoth(session);
      const log = await driveSession(session, engine);
      const turns = session.record.turns;
      const forfeits = turns.map((t, i) => ({ t, i })).filter(({ t }) => t.action === "move" && t.play === "");
      expect(forfeits.length).toBeGreaterThan(0);
      for (const { t, i } of forfeits) {
        // The forfeited move follows the roll it could not play, by the same player with the same dice ...
        expect(turns[i - 1]).toEqual({ player: t.player, dice: t.dice, action: "roll", play: null, resignPoints: null });
        // ... and the client only ever saw the state after both turns: the opponent to roll.
        const state = log.states.find((s) => s.lastTurnIndex === i);
        expect(state).toBeDefined();
        expect(state?.match.game).toMatchObject({ phase: "toRoll", onRoll: t.player === "white" ? "black" : "white" });
        expect(log.states.some((s) => s.lastTurnIndex === i - 1)).toBe(false);
      }
      expect(log.states).toHaveLength(log.actions.length);
      expect(engine.replay(session.record)).toEqual(session.match);
    }, 60_000);

    it("refuses actions out of turn, out of phase, illegal plays and an unavailable cube", async () => {
      const { session, store } = table(newRecord(42, 0));
      await joinBoth(session);
      // Seed 42: White won the opening roll 5-1 and is to move.
      expect(session.match.game).toMatchObject({ phase: "toMove", onRoll: "white" });
      const legal = engine.legalPlays(session.match.game.board, "white", { hi: 5, lo: 1 }).map((p) => p.notation);

      expect(await expectRejected(session, 1, clientMsg("move", { play: legal[0] }), "notYourTurn")).toMatch(/White/);
      await expectRejected(session, 1, clientMsg("roll"), "notYourTurn");
      await expectRejected(session, 1, clientMsg("resign", { kind: "single" }), "notYourTurn");
      await expectRejected(session, 0, clientMsg("roll"), "wrongPhase");
      await expectRejected(session, 0, clientMsg("double"), "wrongPhase");
      await expectRejected(session, 1, clientMsg("take"), "wrongPhase");
      await expectRejected(session, 1, clientMsg("drop"), "wrongPhase");
      await expectRejected(session, 0, clientMsg("nextGame"), "wrongPhase");
      expect(await expectRejected(session, 0, clientMsg("move", { play: "garbage" }), "illegal")).toMatch(/garbage/);
      await expectRejected(session, 0, clientMsg("move", { play: "24/18 13/10" }), "illegal");
      await expectRejected(session, 0, clientMsg("move", { play: "" }), "illegal");
      // Only the accepted opening roll has been stored so far.
      expect(store.turns).toHaveLength(1);
      expect(session.record.turns).toHaveLength(1);

      const moved = await sendAccepted(session, 0, clientMsg("move", { play: legal[0] }));
      expect(moved.broadcast).toEqual([expect.objectContaining({ type: "state", lastTurnIndex: 1 })]);
      expect(session.match.game).toMatchObject({ phase: "toRoll", onRoll: "black" });
      expect(store.turns).toHaveLength(2);

      // Black may double with the cube centred; White takes; the cube is then White's and Black may not redouble.
      await expectRejected(session, 0, clientMsg("take"), "wrongPhase");
      await sendAccepted(session, 1, clientMsg("double"));
      expect(session.match.game.phase).toBe("doubled");
      await expectRejected(session, 1, clientMsg("take"), "notYourTurn");
      await expectRejected(session, 1, clientMsg("roll"), "wrongPhase");
      await expectRejected(session, 0, clientMsg("roll"), "notYourTurn");
      await sendAccepted(session, 0, clientMsg("take"));
      expect(session.match.game).toMatchObject({ phase: "toRoll", onRoll: "black", cube: { value: 2, owner: "white" } });
      expect(await expectRejected(session, 1, clientMsg("double"), "illegal")).toMatch(/cube/);
      await sendAccepted(session, 1, clientMsg("roll"));
      expect(session.match.game.phase).toBe("toMove");
      expect(engine.replay(session.record)).toEqual(session.match);
    });

    it("an accepted resignation concedes what the rules award and finishes a money game", async () => {
      const { session, store } = table(newRecord(42, 0));
      await joinBoth(session);
      // Jacoby, centred cube: a gammon resigned counts a single point.
      const { broadcast } = await resignAccepted(session, 0, "gammon");
      expect(broadcast.map((m) => m.type)).toEqual(["state", "gameOver"]);
      expect(broadcast[1]).toEqual({ type: "gameOver", result: { winner: "black", kind: "single", points: 1 }, matchOver: true });
      expect(session.record.turns.at(-1)).toMatchObject({ action: "resign", player: "white", resignPoints: 1 });
      expect(session.status).toBe("finished");
      expect(engine.replay(session.record)).toEqual(session.match);
      expect(store.turns.at(-1)).toMatchObject({ status: "finished", result: { winner: "black", kind: "single", points: 1, score: { white: 0, black: 1 } } });
    });

    it("does not advance or broadcast when the store refuses the turn", async () => {
      const { session, store } = table(newRecord(42, 0));
      await joinBoth(session);
      const before = session.record;
      store.failNext = new Error("database down");
      const legal = engine.legalPlays(session.match.game.board, "white", { hi: 5, lo: 1 })[0].notation;
      await expect(session.handle(0, clientMsg("move", { play: legal }))).rejects.toThrow("database down");
      expect(session.record).toEqual(before);
      expect(session.match.game.phase).toBe("toMove");
      // The same move goes through once the store is back.
      const retried = await sendAccepted(session, 0, clientMsg("move", { play: legal }));
      expect(retried.broadcast).toHaveLength(1);
      expect(session.record.turns).toHaveLength(2);
    });
  });

  describe("chat", () => {
    it("broadcasts a line to both seats, stores it and includes it in later snapshots", async () => {
      const { session, store, clock } = table(newRecord(42, 0));
      await joinBoth(session);
      clock.now = 1_700_000_001_234;
      const text = "y".repeat(MAX_CHAT_LENGTH);
      const sent = await session.handle(0, clientMsg("chat", { text }));
      const line: ChatLine = { seat: 0, name: "Alpha", text, at: 1_700_000_001_234 };
      expect(sent.reply).toEqual([{ type: "ack", id: expect.any(String) }]);
      expect(sent.broadcast).toEqual([{ type: "chat", line }]);
      expect(store.chat).toEqual([{ gameId: "game1", line }]);
      expect(snapshotOf((await session.handle(1, clientMsg("join"))).reply).chat).toEqual([line]);
      expect(session.chat).toEqual([line]);
    });

    it("a chat that fails validation never reaches the session", () => {
      const tooLong = parseClientMsg(JSON.stringify({ id: "c1", type: "chat", text: "z".repeat(MAX_CHAT_LENGTH + 1) }));
      expect(tooLong.ok).toBe(false);
      const unknown = parseClientMsg(JSON.stringify({ id: "u1", type: "cheat", play: "24/1" }));
      expect(unknown).toMatchObject({ ok: false, id: "u1" });
    });

    it("starts with the stored history", async () => {
      const history: ChatLine[] = [{ seat: 1, name: "Beta", text: "earlier", at: 5 }];
      const { session } = table(newRecord(42, 0), { chat: history });
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply).chat).toEqual(history);
    });
  });

  it("stamps the last action time from the injected clock", async () => {
    const { session, clock } = table(newRecord(42, 0));
    expect(session.lastActionAt).toBe(clock.now);
    expect(table(newRecord(42, 0), { lastActionAt: 12_345 }).session.lastActionAt).toBe(12_345);
    clock.now += 5_000;
    await joinBoth(session);
    expect(session.lastActionAt).toBe(clock.now);
    clock.now += 5_000;
    await playUntilTurnOf(session, "black", "toRoll");
    expect(session.lastActionAt).toBe(clock.now);
  });
});
