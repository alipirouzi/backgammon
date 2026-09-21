// GameSession, match play (plan Task 2): a 3-point match between two
// scripted seats with a resignation, doubles and the next-game votes; the
// vote-or-30 s rule between games; resuming a stored record mid-match,
// between games, finished and abandoned. Real wasm engine; skipped when
// engine/bg-wasm/pkg is not built (fails under CI like the parity suite).

import { beforeAll, describe, expect, it, vi } from "vitest";

import { locateBgWasmPkg, type EngineSync } from "../../src/engine/node";
import type { MatchState, Record as GameRecord } from "../../src/engine/types";
import { newRecord } from "../../src/game/record";
import { toWireRecord } from "../../src/realtime/protocol-engine";
import { NEXT_GAME_TIMEOUT_MS } from "../../src/realtime/session";

import { clientMsg, driveSession, sendAccepted } from "./drive";
import { MemoryStore, ensureEngine, expectRejected, finishFirstGame, joinBoth, resignAccepted, snapshotOf, table } from "./harness";

let engine: EngineSync;

describe.skipIf(locateBgWasmPkg() === null)("GameSession in a match", () => {
  beforeAll(async () => {
    engine = await ensureEngine();
  });

  describe("a 3-point match", () => {
    it("plays with a resignation, doubles and the next-game votes until it is decided", async () => {
      const { session, store, timer } = table(newRecord(7, 3));
      await joinBoth(session);
      const log = await driveSession(session, engine, {
        // Resign the first game early (one point at cube 1) so the match goes on.
        resign: (ctx) => (ctx.games === 0 && ctx.actions.length >= 6 && !ctx.actions.includes("resign") ? "single" : null),
        // From the second game on, double whenever allowed; the other seat always takes.
        double: (ctx) => ctx.games >= 1,
      });

      const match = session.match;
      expect(session.status).toBe("finished");
      expect(match.game.phase).toBe("finished");
      expect(Math.max(match.score.white, match.score.black)).toBeGreaterThanOrEqual(3);
      expect(log.gameOvers.length).toBeGreaterThanOrEqual(2);
      expect(log.gameOvers.slice(0, -1).every((g) => !g.matchOver)).toBe(true);
      expect(log.gameOvers.at(-1)).toEqual({ type: "gameOver", result: match.game.result, matchOver: true });
      expect(log.gameOvers[0]).toMatchObject({ result: { kind: "single", points: 1 } });
      // Every game but the last was followed by both votes.
      expect(log.actions.filter((a) => a === "next")).toHaveLength(2 * (log.gameOvers.length - 1));
      expect(log.actions.filter((a) => a === "resign")).toHaveLength(1);
      expect(log.actions.filter((a) => a === "double").length).toBeGreaterThanOrEqual(1);
      expect(timer.pending).toEqual([]);

      const record = session.record;
      expect(record.length).toBe(3);
      expect(record.turns.filter((t) => t.action === "resign")).toHaveLength(1);
      expect(engine.replay(record)).toEqual(match);
      expect(store.turns.at(-1)).toMatchObject({ status: "finished", result: { ...match.game.result, score: match.score } });
      expect(store.turns.at(-1)!.record).toEqual(record);
      // Between games the stored status stayed active.
      expect(store.turns.slice(0, -1).every((t) => t.status === "active")).toBe(true);
    }, 120_000);

    it("between games: the next game starts when both have voted, or 30 s after the first vote", async () => {
      const { session, store, timer, unsolicited } = table(newRecord(7, 3));
      await joinBoth(session);
      await finishFirstGame(session);
      expect(session.match.game.phase).toBe("openingRoll");
      expect(session.match.score.white + session.match.score.black).toBe(1);
      expect(session.status).toBe("active");
      const turnsBefore = session.record.turns.length;
      // No timer runs until someone votes; game actions are refused meanwhile.
      expect(timer.pending).toEqual([]);
      await expectRejected(session, 0, clientMsg("roll"), "wrongPhase");
      await expectRejected(session, 1, clientMsg("double"), "wrongPhase");

      const first = await sendAccepted(session, 1, clientMsg("nextGame"));
      expect(first.broadcast).toEqual([]);
      expect(session.awaitingNextGame).toBe(true);
      expect(timer.pending).toHaveLength(1);
      expect(timer.pending[0].ms).toBe(NEXT_GAME_TIMEOUT_MS);
      // Voting twice changes nothing.
      await sendAccepted(session, 1, clientMsg("nextGame"));
      expect(timer.pending).toHaveLength(1);
      expect(session.record.turns).toHaveLength(turnsBefore);

      timer.fire();
      await vi.waitFor(() => expect(session.awaitingNextGame).toBe(false));
      expect(session.record.turns).toHaveLength(turnsBefore + 1);
      expect(session.record.turns.at(-1)).toMatchObject({ action: "roll" });
      expect(session.match.game.phase).toBe("toMove");
      expect(unsolicited).toEqual([
        { type: "state", record: toWireRecord(session.record, false), match: session.match, awaitingNextGame: false, lastTurnIndex: turnsBefore },
      ]);
      expect(store.turns.at(-1)!.record).toEqual(session.record);
      expect(engine.replay(session.record)).toEqual(session.match);
      // A late vote is refused: the game is on.
      await expectRejected(session, 0, clientMsg("nextGame"), "wrongPhase");
    }, 60_000);

    it("both votes start the next game at once and cancel the timer", async () => {
      const { session, timer, unsolicited } = table(newRecord(7, 3));
      await joinBoth(session);
      await finishFirstGame(session);
      const turnsBefore = session.record.turns.length;
      await sendAccepted(session, 0, clientMsg("nextGame"));
      expect(timer.pending).toHaveLength(1);
      const second = await sendAccepted(session, 1, clientMsg("nextGame"));
      expect(session.awaitingNextGame).toBe(false);
      expect(timer.pending).toEqual([]);
      expect(second.broadcast).toEqual([expect.objectContaining({ type: "state", awaitingNextGame: false, lastTurnIndex: turnsBefore })]);
      expect(unsolicited).toEqual([]);
      session.dispose();
    });
  });

  describe("resuming a stored record", () => {
    it("picks a match up mid-way with the dice in step and plays it to the end", async () => {
      const store = new MemoryStore();
      const first = table(newRecord(11, 3), { store });
      await joinBoth(first.session);
      const partial = await driveSession(first.session, engine, { double: () => true, maxActions: 9 });
      expect(partial.stopped).toBe(true);
      const stored = store.turns.at(-1)!;
      expect(stored.record).toEqual(first.session.record);
      expect(stored.status).toBe("active");
      first.session.dispose();

      const second = table(stored.record, { store, status: stored.status });
      expect(second.session.status).toBe("active");
      expect(second.session.match).toEqual(engine.replay(stored.record));
      expect(second.session.match).toEqual(first.session.match);
      const { b } = await joinBoth(second.session);
      expect(b.broadcast).toEqual([]);
      const rest = await driveSession(second.session, engine);
      expect(rest.stopped).toBe(false);
      const final: MatchState = second.session.match;
      expect(second.session.status).toBe("finished");
      expect(Math.max(final.score.white, final.score.black)).toBeGreaterThanOrEqual(3);
      expect(engine.replay(second.session.record)).toEqual(final);
      expect(second.session.record.turns.slice(0, stored.record.turns.length)).toEqual(stored.record.turns);
    }, 120_000);

    it("a record stored between two games of a match resumes as awaiting the next game", async () => {
      const { session } = table(newRecord(7, 3));
      await joinBoth(session);
      await finishFirstGame(session);
      const resumed = table(session.record, { status: "active" });
      expect(resumed.session.awaitingNextGame).toBe(true);
      expect(resumed.timer.pending).toEqual([]);
      const snap = snapshotOf((await resumed.session.handle(0, clientMsg("join"))).reply);
      expect(snap.awaitingNextGame).toBe(true);
      await sendAccepted(resumed.session, 0, clientMsg("nextGame"));
      await sendAccepted(resumed.session, 1, clientMsg("nextGame"));
      expect(resumed.session.awaitingNextGame).toBe(false);
      expect(engine.replay(resumed.session.record)).toEqual(resumed.session.match);
    });

    it("a finished or abandoned game is read-only", async () => {
      const { session } = table(newRecord(42, 0));
      await joinBoth(session);
      await resignAccepted(session, 0, "single");
      const finished = table(session.record, { status: "finished" });
      expect(finished.session.status).toBe("finished");
      await expectRejected(finished.session, 1, clientMsg("roll"), "gameOver");

      const abandoned = table(newRecord(42, 0), { status: "abandoned" });
      await joinBoth(abandoned.session);
      expect(abandoned.session.record.turns).toEqual([]);
      await expectRejected(abandoned.session, 0, clientMsg("roll"), "gameOver");
      expect(abandoned.session.status).toBe("abandoned");
    });

    it("refuses a record whose dice do not follow its seed", () => {
      const bad = newRecord(42, 0);
      const record: GameRecord = {
        ...bad,
        turns: [{ player: "white", dice: { hi: 6, lo: 6 }, action: "roll", play: null, resignPoints: null }],
      };
      expect(() => table(record)).toThrow(/seed/);
    });
  });
});
