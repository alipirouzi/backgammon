// GameSession, the integrity fixes of the review: the record on the wire
// carries no seed while the game is live (either seat could otherwise list
// every future roll), resignation is an offer the opponent accepts or
// declines, a resent client id gets its stored answer instead of a second
// execution, the snapshot says whether the session is read-only and how the
// next-game vote stands, and a next game that fails to start on the timer
// is retried with backoff (three times, then on the next frame). Real wasm
// engine; skipped when engine/bg-wasm/pkg is not built.

import { beforeAll, describe, expect, it, vi } from "vitest";

import { locateBgWasmPkg, type EngineSync } from "../../src/engine/node";
import { newRecord } from "../../src/game/record";
import type { ClientMsg, ServerMsg } from "../../src/realtime/protocol";
import { toWireRecord } from "../../src/realtime/protocol-engine";
import { NEXT_GAME_RETRIES, NEXT_GAME_RETRY_MS, NEXT_GAME_TIMEOUT_MS, REPLY_MEMORY } from "../../src/realtime/session";

import { clientMsg, driveSession, sendAccepted } from "./drive";
import { ensureEngine, expectRejected, finishFirstGame, joinBoth, resignAccepted, snapshotOf, table } from "./harness";

let engine: EngineSync;

const types = (msgs: ServerMsg[]): string[] => msgs.map((m) => m.type);

describe.skipIf(locateBgWasmPkg() === null)("GameSession integrity", () => {
  beforeAll(async () => {
    engine = await ensureEngine();
  });

  describe("the seed stays on the server while the game is live", () => {
    it("snapshot and state carry the record without its seed until the game is over", async () => {
      const { session } = table(newRecord(42, 0));
      const { a, b } = await joinBoth(session);
      const snap = snapshotOf(b.reply);
      expect("seed" in snap.record).toBe(false);
      expect(snap.record).toEqual(toWireRecord(session.record, false));
      // The first join drew the opening roll and broadcast it.
      const state = a.broadcast.find((m) => m.type === "state");
      expect(state).toBeDefined();
      expect(state?.type === "state" && "seed" in state.record).toBe(false);

      const log = await driveSession(session, engine);
      expect(session.status).toBe("finished");
      // Every state but the finishing one was seedless; the last reveals it.
      expect(log.states.slice(0, -1).every((s) => !("seed" in s.record))).toBe(true);
      expect(log.states.at(-1)?.record).toEqual(session.record);
      expect(log.states.at(-1)?.record.seed).toBe(42);
      expect(snapshotOf((await session.handle(1, clientMsg("join"))).reply).record).toEqual(session.record);
    }, 60_000);

    it("an abandoned session reveals the seed in its snapshot", async () => {
      const { session } = table(newRecord(42, 0), { status: "abandoned" });
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply).record.seed).toBe(42);
    });
  });

  describe("the snapshot says what the client needs after a reconnect", () => {
    it("carries the status, the next-game votes and the deadline", async () => {
      const { session, clock } = table(newRecord(7, 3));
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply)).toMatchObject({
        status: "active",
        nextGame: { votes: [false, false], startsAt: null },
        resignOffer: null,
      });
      await finishFirstGame(session);
      await sendAccepted(session, 1, clientMsg("nextGame"));
      const snap = snapshotOf((await session.handle(0, clientMsg("join"))).reply);
      expect(snap.awaitingNextGame).toBe(true);
      expect(snap.nextGame).toEqual({ votes: [false, true], startsAt: clock.now + NEXT_GAME_TIMEOUT_MS });
      await sendAccepted(session, 0, clientMsg("nextGame"));
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply).nextGame).toEqual({ votes: [false, false], startsAt: null });
    }, 60_000);

    it("reports finished and abandoned sessions as such", async () => {
      const { session } = table(newRecord(42, 0));
      await joinBoth(session);
      await resignAccepted(session, 0, "single");
      expect(snapshotOf((await session.handle(1, clientMsg("join"))).reply).status).toBe("finished");
      const abandoned = table(newRecord(42, 0), { status: "abandoned" });
      expect(snapshotOf((await abandoned.session.handle(0, clientMsg("join"))).reply).status).toBe("abandoned");
    });
  });

  describe("resignation is an offer", () => {
    it("is broadcast with the points the rules award and ends the game only when the opponent accepts", async () => {
      const { session, store } = table(newRecord(42, 0));
      await joinBoth(session);
      const turns = session.record.turns.length;
      // Jacoby, centred cube: a gammon offered is priced as a single point.
      const offered = await sendAccepted(session, 0, clientMsg("resign", { kind: "gammon" }));
      const offer = { seat: 0, kind: "gammon", points: 1 };
      expect(offered.broadcast).toEqual([{ type: "resignOffered", offer }]);
      expect(session.record.turns).toHaveLength(turns);
      expect(session.status).toBe("active");
      expect(store.turns).toHaveLength(1);
      expect(snapshotOf((await session.handle(1, clientMsg("join"))).reply).resignOffer).toEqual(offer);
      // Offering again changes nothing; the offerer cannot accept its own offer.
      expect((await sendAccepted(session, 0, clientMsg("resign", { kind: "single" }))).broadcast).toEqual([{ type: "resignOffered", offer: { seat: 0, kind: "single", points: 1 } }]);
      await expectRejected(session, 0, clientMsg("acceptResign"), "notYourTurn");

      const accepted = await sendAccepted(session, 1, clientMsg("acceptResign"));
      expect(types(accepted.broadcast)).toEqual(["state", "gameOver"]);
      expect(accepted.broadcast[1]).toEqual({ type: "gameOver", result: { winner: "black", kind: "single", points: 1 }, matchOver: true });
      expect(session.record.turns.at(-1)).toMatchObject({ action: "resign", player: "white", resignPoints: 1 });
      expect(session.status).toBe("finished");
      expect(engine.replay(session.record)).toEqual(session.match);
      expect(store.turns.at(-1)).toMatchObject({ status: "finished", result: { winner: "black", kind: "single", points: 1, score: { white: 0, black: 1 } } });
      expect(snapshotOf((await session.handle(1, clientMsg("join"))).reply).resignOffer).toBeNull();
    });

    it("can be declined, and is withdrawn by the offerer's next game action", async () => {
      const { session } = table(newRecord(42, 0));
      await joinBoth(session);
      await expectRejected(session, 1, clientMsg("acceptResign"), "wrongPhase");
      await expectRejected(session, 1, clientMsg("declineResign"), "wrongPhase");

      await sendAccepted(session, 0, clientMsg("resign", { kind: "single" }));
      const offer = { seat: 0, kind: "single", points: 1 };
      const declined = await sendAccepted(session, 1, clientMsg("declineResign"));
      expect(declined.broadcast).toEqual([{ type: "resignCleared", offer, reason: "declined" }]);
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply).resignOffer).toBeNull();
      await expectRejected(session, 1, clientMsg("acceptResign"), "wrongPhase");

      await sendAccepted(session, 0, clientMsg("resign", { kind: "single" }));
      const play = engine.legalPlays(session.match.game.board, "white", { hi: 5, lo: 1 })[0].notation;
      const moved = await sendAccepted(session, 0, clientMsg("move", { play }));
      expect(types(moved.broadcast)).toEqual(["resignCleared", "state"]);
      expect(moved.broadcast[0]).toEqual({ type: "resignCleared", offer, reason: "withdrawn" });
      expect(session.match.game).toMatchObject({ phase: "toRoll", onRoll: "black" });
      // The offer is gone: Black's answer finds nothing to answer.
      await expectRejected(session, 1, clientMsg("acceptResign"), "wrongPhase");
      expect(engine.replay(session.record)).toEqual(session.match);
    });

    it("prices the offer at the cube in force and lets a match go on", async () => {
      const { session } = table(newRecord(7, 3));
      await joinBoth(session);
      const { a } = { a: session.match.game.onRoll! };
      const mover = a === "white" ? 0 : 1;
      const other = mover === 0 ? 1 : 0;
      // Play the opening move so the opponent is to roll, then that player doubles and the mover takes.
      const play = engine.legalPlays(session.match.game.board, a, session.match.game.dice!)[0].notation;
      await sendAccepted(session, mover, clientMsg("move", { play }));
      await sendAccepted(session, other, clientMsg("double"));
      await sendAccepted(session, mover, clientMsg("take"));
      expect(session.match.game.cube).toEqual({ value: 2, owner: a });
      const offered = await sendAccepted(session, other, clientMsg("resign", { kind: "gammon" }));
      expect(offered.broadcast).toEqual([{ type: "resignOffered", offer: { seat: other, kind: "gammon", points: 4 } }]);
      const accepted = await sendAccepted(session, mover, clientMsg("acceptResign"));
      expect(accepted.broadcast.at(-1)).toEqual({ type: "gameOver", result: { winner: a, kind: "gammon", points: 4 }, matchOver: true });
    });

    it("is refused once the game is over, and the answers are refused between the games of a match", async () => {
      const { session } = table(newRecord(7, 3));
      await joinBoth(session);
      await finishFirstGame(session);
      await expectRejected(session, 0, clientMsg("acceptResign"), "wrongPhase");
      await expectRejected(session, 1, clientMsg("declineResign"), "wrongPhase");
      const done = table(newRecord(42, 0), { status: "abandoned" });
      await expectRejected(done.session, 0, clientMsg("acceptResign"), "gameOver");
      await expectRejected(done.session, 1, clientMsg("declineResign"), "gameOver");
    }, 60_000);
  });

  describe("a resent message id gets its stored answer", () => {
    it("stores and broadcasts a chat line once, whatever the id is resent", async () => {
      const { session, store } = table(newRecord(42, 0));
      await joinBoth(session);
      const msg = clientMsg("chat", { text: "hello" });
      const first = await session.handle(0, msg);
      const again = await session.handle(0, msg);
      expect(again).toEqual({ reply: first.reply, broadcast: [] });
      expect(store.chat).toHaveLength(1);
      expect(session.chat).toHaveLength(1);
      // The other seat may use the same id: ids are per seat.
      const other = await session.handle(1, { ...msg, text: "hi" });
      expect(other.broadcast).toEqual([{ type: "chat", line: expect.objectContaining({ seat: 1, text: "hi" }) }]);
      expect(store.chat).toHaveLength(2);
    });

    it("does not act twice on a resent game action, even after the phase came round again", async () => {
      const { session } = table(newRecord(42, 0));
      await joinBoth(session);
      // Seed 42: White is to move 5-1; play, then Black rolls with `r1`.
      const white = engine.legalPlays(session.match.game.board, "white", { hi: 5, lo: 1 })[0].notation;
      await sendAccepted(session, 0, clientMsg("move", { play: white }));
      const roll: ClientMsg = clientMsg("roll");
      const rolled = await sendAccepted(session, 1, roll);
      const turns = session.record.turns.length;
      // Resent at once: the stored ack, no new roll, no broadcast.
      expect(await session.handle(1, roll)).toEqual({ reply: rolled.reply, broadcast: [] });
      expect(session.record.turns).toHaveLength(turns);
      // A rejection is remembered too.
      const early = clientMsg("roll");
      const refused = await session.handle(0, early);
      expect(refused.reply[0]).toMatchObject({ type: "rejected", code: "notYourTurn" });
      expect(await session.handle(0, early)).toEqual({ reply: refused.reply, broadcast: [] });
      // `join` and `ping` are never replayed from memory: a second join is a fresh snapshot.
      const j = clientMsg("join");
      const s1 = await session.handle(0, j);
      expect((await session.handle(0, j)).reply).toEqual(s1.reply);
      expect(types(s1.reply)).toEqual(["snapshot", "ack"]);
      const p = clientMsg("ping");
      expect(await session.handle(0, p)).toEqual({ reply: [{ type: "pong" }], broadcast: [] });
      expect(await session.handle(0, p)).toEqual({ reply: [{ type: "pong" }], broadcast: [] });
    });

    it("remembers only the most recent ids of a seat", async () => {
      expect(REPLY_MEMORY).toBe(50);
      const { session, store } = table(newRecord(42, 0));
      await joinBoth(session);
      const oldest = clientMsg("chat", { text: "first" });
      await session.handle(0, oldest);
      for (let i = 0; i < REPLY_MEMORY; i++) {
        await session.handle(0, clientMsg("chat", { text: `line ${String(i)}` }));
      }
      expect(store.chat).toHaveLength(REPLY_MEMORY + 1);
      // Pushed out of memory, the oldest id is treated as new.
      const replayed = await session.handle(0, oldest);
      expect(replayed.broadcast).toHaveLength(1);
      expect(store.chat).toHaveLength(REPLY_MEMORY + 2);
    });
  });

  describe("the next game on the timer", () => {
    it("is retried when the store refuses the opening roll, so the match does not stall", async () => {
      const { session, store, timer, unsolicited, clock } = table(newRecord(7, 3));
      await joinBoth(session);
      await finishFirstGame(session);
      await sendAccepted(session, 0, clientMsg("nextGame"));
      expect(timer.pending.map((t) => t.ms)).toEqual([NEXT_GAME_TIMEOUT_MS]);

      store.failNext = new Error("database down");
      timer.fire();
      await vi.waitFor(() => expect(timer.pending).toHaveLength(1));
      expect(session.awaitingNextGame).toBe(true);
      expect(unsolicited).toEqual([]);
      expect(timer.pending[0].ms).toBe(NEXT_GAME_RETRY_MS);
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply).nextGame).toEqual({ votes: [true, false], startsAt: clock.now + NEXT_GAME_RETRY_MS });

      timer.fire();
      await vi.waitFor(() => expect(session.awaitingNextGame).toBe(false));
      expect(types(unsolicited)).toEqual(["state"]);
      expect(timer.pending).toEqual([]);
    }, 60_000);

    it("backs off over three retries, then waits for the next frame to try again", async () => {
      expect(NEXT_GAME_RETRIES).toBe(3);
      const { session, store, timer, unsolicited, clock } = table(newRecord(7, 3));
      await joinBoth(session);
      await finishFirstGame(session);
      const turns = session.record.turns.length;
      await sendAccepted(session, 1, clientMsg("nextGame"));

      // The timer's own attempt fails, then each retry: 5 s, 10 s, 20 s.
      const delays: number[] = [];
      for (let attempt = 0; attempt <= NEXT_GAME_RETRIES; attempt++) {
        expect(timer.pending).toHaveLength(1);
        store.failNext = new Error("database down");
        timer.fire();
        if (attempt < NEXT_GAME_RETRIES) {
          await vi.waitFor(() => expect(timer.pending).toHaveLength(1));
          delays.push(timer.pending[0].ms);
        } else {
          // Spent: the failure is handled on the session's queue, so a frame sent now runs after it.
          await session.handle(1, clientMsg("ping"));
        }
      }
      expect(delays).toEqual([NEXT_GAME_RETRY_MS, NEXT_GAME_RETRY_MS * 2, NEXT_GAME_RETRY_MS * 4]);
      expect(session.awaitingNextGame).toBe(true);
      expect(session.record.turns).toHaveLength(turns);
      expect(unsolicited).toEqual([]);
      // The ping above was the "next frame": it re-armed the timer at the base delay, which the snapshot reports.
      expect(timer.pending.map((t) => t.ms)).toEqual([NEXT_GAME_RETRY_MS]);
      const snap = snapshotOf((await session.handle(0, clientMsg("join"))).reply);
      expect(snap.nextGame).toEqual({ votes: [false, true], startsAt: clock.now + NEXT_GAME_RETRY_MS });
      // Frames while a timer is armed change nothing.
      await session.handle(0, clientMsg("ping"));
      expect(timer.pending).toHaveLength(1);

      // With the store back, the re-armed timer starts the game and the votes are forgotten.
      timer.fire();
      await vi.waitFor(() => expect(session.awaitingNextGame).toBe(false));
      expect(types(unsolicited)).toEqual(["state"]);
      expect(session.record.turns).toHaveLength(turns + 1);
      expect(timer.pending).toEqual([]);
      expect(snapshotOf((await session.handle(0, clientMsg("join"))).reply).nextGame).toEqual({ votes: [false, false], startsAt: null });
    }, 60_000);

    it("the other seat's vote after a spent retry sequence starts the game at once and leaves no timer", async () => {
      const { session, store, timer } = table(newRecord(7, 3));
      await joinBoth(session);
      await finishFirstGame(session);
      await sendAccepted(session, 0, clientMsg("nextGame"));
      for (let attempt = 0; attempt <= NEXT_GAME_RETRIES; attempt++) {
        store.failNext = new Error("database down");
        timer.fire();
        if (attempt < NEXT_GAME_RETRIES) {
          await vi.waitFor(() => expect(timer.pending).toHaveLength(1));
        }
      }
      // The second vote is itself a frame: both votes stand, so the game starts at once and no timer is left.
      const second = await sendAccepted(session, 1, clientMsg("nextGame"));
      expect(types(second.broadcast)).toEqual(["state"]);
      expect(session.awaitingNextGame).toBe(false);
      expect(timer.pending).toEqual([]);
    }, 60_000);
  });
});
