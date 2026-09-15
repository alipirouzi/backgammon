// The verify-and-store service behind POST /api/games (web/src/server/games.ts)
// with Prisma mocked: payload validation never touches the engine or the
// database; the replay cases run the real bg-wasm engine in Node on the
// fixture records and are skipped when engine/bg-wasm/pkg is not built.
//
// Fixtures (tests/fixtures/*.json) were produced with the store against the
// real engine using the scripted human of store-engine.test.ts (`playOut`:
// first legal source, first legal target, take every double):
//   finished-record.json        single game, beginner, seed 42, no decisions
//   finished-match-record.json  5-point match, beginner, seed 7; resign the
//                               first game once 6 actions were played, then
//                               double whenever allowed from game 2 on
// Both are exactly what `replay` accepts; regenerate them the same way if a
// rules change ever invalidates them.

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadEngineNode, locateBgWasmPkg } from "../src/engine/node";
import type { Record as GameRecord } from "../src/engine/types";

const db = vi.hoisted(() => ({
  game: {
    create: vi.fn(),
    findUnique: vi.fn(),
  },
}));

vi.mock("../src/server/db", () => ({ getDb: () => db }));

import { GameNotFinished, RecordInvalid, getGame, verifyAndStore, type SeatsInput } from "../src/server/games";

function fixture(name: string): GameRecord {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as GameRecord;
}

const single = fixture("finished-record.json");
const match = fixture("finished-match-record.json");

const SEATS: SeatsInput = { white: { kind: "guest", name: "Player One" }, black: { kind: "bot", level: "beginner" } };

const pkgDir = locateBgWasmPkg();

beforeEach(() => {
  db.game.create.mockReset();
  db.game.findUnique.mockReset();
  db.game.create.mockImplementation(async (args: { data: unknown }) => ({ id: "game_1", ...(args.data as object) }));
});

describe("verifyAndStore — payload validation (no engine, no database)", () => {
  it.each([
    ["not an object", 42],
    ["null", null],
    ["missing turns", { seed: 1, length: 0, rules: single.rules }],
    ["seed above 2^53 - 1", { ...single, seed: 2 ** 53 }],
    ["negative seed", { ...single, seed: -1 }],
    ["fractional seed", { ...single, seed: 1.5 }],
    ["length out of range", { ...single, length: 256 }],
    ["rules not booleans", { ...single, rules: { jacoby: "yes", beavers: false, autoDoubles: false } }],
    ["turn with an unknown player", { ...single, turns: [{ ...single.turns[0], player: "red" }] }],
    ["turn with an unknown action", { ...single, turns: [{ ...single.turns[0], action: "pass" }] }],
    ["turn with dice out of range", { ...single, turns: [{ ...single.turns[0], dice: { hi: 7, lo: 1 } }] }],
    ["turn with dice not ordered", { ...single, turns: [{ ...single.turns[0], dice: { hi: 1, lo: 5 } }] }],
    ["turn with a non-string play", { ...single, turns: [{ ...single.turns[1], play: 7 }] }],
    ["turn that is not an object", { ...single, turns: ["roll"] }],
  ])("rejects a record that is %s with RecordInvalid", async (_label, record) => {
    await expect(verifyAndStore(record, SEATS)).rejects.toBeInstanceOf(RecordInvalid);
    expect(db.game.create).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["without a black seat", { white: SEATS.white }],
    ["with an unknown seat kind", { ...SEATS, white: { kind: "alien", name: "x" } }],
    ["with an empty guest name", { ...SEATS, white: { kind: "guest", name: "   " } }],
    ["with a guest name over 40 characters", { ...SEATS, white: { kind: "guest", name: "x".repeat(41) } }],
    ["with an unknown bot level", { ...SEATS, black: { kind: "bot", level: "grandmaster" } }],
    ["with a bot seat lacking a level", { ...SEATS, black: { kind: "bot" } }],
    ["with two bots (the level of one would be lost)", { white: { kind: "bot", level: "club" }, black: { kind: "bot", level: "beginner" } }],
    ["with two guests (a bot game needs the computer)", { ...SEATS, black: { kind: "guest", name: "Player Two" } }],
  ])("rejects seats %s with RecordInvalid", async (_label, seats) => {
    await expect(verifyAndStore(single, seats)).rejects.toBeInstanceOf(RecordInvalid);
    expect(db.game.create).not.toHaveBeenCalled();
  });

  it("names the seat rule when the pair is not one guest and one bot", async () => {
    const error = await verifyAndStore(single, { white: SEATS.white, black: SEATS.white }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordInvalid);
    expect((error as Error).message).toBe("seats must hold exactly one guest and one bot");
  });

  it("typed errors are Errors with stable names", () => {
    const invalid = new RecordInvalid("bad");
    const unfinished = new GameNotFinished("still going");
    expect(invalid).toBeInstanceOf(Error);
    expect(invalid.name).toBe("RecordInvalid");
    expect(invalid.message).toBe("bad");
    expect(unfinished).toBeInstanceOf(Error);
    expect(unfinished.name).toBe("GameNotFinished");
    expect(unfinished).not.toBeInstanceOf(RecordInvalid);
  });
});

describe.skipIf(pkgDir === null)("verifyAndStore — replay through the real engine", () => {
  it("rejects a record the engine refuses to replay (logged dice off the seed)", async () => {
    // The first roll after the opening roll (turn 4 in this fixture: Black's 3-3).
    const at = single.turns.findIndex((t, i) => i > 0 && t.action === "roll");
    expect(at).toBeGreaterThan(0);
    const turns = single.turns.map((t, i) => (i === at ? { ...t, dice: { hi: 6, lo: 6 } } : t));
    const error = await verifyAndStore({ ...single, turns }, SEATS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordInvalid);
    expect((error as Error).message).toMatch(/does not replay: .*logged dice 6-6 but the seed gives/);
    expect(db.game.create).not.toHaveBeenCalled();
  });

  it("rejects a record with an illegal play", async () => {
    const turns = single.turns.map((t, i) => (i === 1 ? { ...t, play: "24/18 13/12" } : t));
    await expect(verifyAndStore({ ...single, turns }, SEATS)).rejects.toThrow(/does not replay: illegal play/);
    expect(db.game.create).not.toHaveBeenCalled();
  });

  it("rejects a game that is still in progress with GameNotFinished", async () => {
    await expect(verifyAndStore({ ...single, turns: single.turns.slice(0, 20) }, SEATS)).rejects.toBeInstanceOf(GameNotFinished);
    expect(db.game.create).not.toHaveBeenCalled();
  });

  it("rejects a match whose first game is over but which is not yet decided", async () => {
    const resignAt = match.turns.findIndex((t) => t.action === "resign");
    expect(resignAt).toBeGreaterThan(0);
    const engine = await loadEngineNode();
    const afterFirstGame = { ...match, turns: match.turns.slice(0, resignAt + 1) };
    // The engine has already moved on to the next game's opening roll.
    expect(engine.replay(afterFirstGame).game.phase).toBe("openingRoll");
    await expect(verifyAndStore(afterFirstGame, SEATS)).rejects.toBeInstanceOf(GameNotFinished);
    expect(db.game.create).not.toHaveBeenCalled();
  });

  it("stores a finished single game with its derived result and both seats, and returns the id", async () => {
    const engine = await loadEngineNode();
    const final = engine.replay(single);
    expect(final.game.phase).toBe("finished");

    const before = Date.now();
    await expect(verifyAndStore(single, SEATS)).resolves.toEqual({ id: "game_1" });

    expect(db.game.create).toHaveBeenCalledTimes(1);
    const { data } = db.game.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      format: "single",
      matchLength: 0,
      status: "finished",
      botLevel: "beginner",
      token: null,
    });
    // `clockConfig` stays at its column default (no clock in bot games).
    expect(data).not.toHaveProperty("clockConfig");
    expect(data.seed).toBe(BigInt(42));
    expect(data.moveLog).toEqual(single);
    expect(data.result).toEqual({ ...final.game.result, score: final.score });
    expect(data.finishedAt).toBeInstanceOf(Date);
    expect((data.finishedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(data.seats).toEqual({
      create: [
        { seat: 0, userId: null, guestName: "Player One", seatSecretHash: null },
        { seat: 1, userId: null, guestName: null, seatSecretHash: null },
      ],
    });
  });

  it("stores a finished match as format match with the match winner and final score", async () => {
    const engine = await loadEngineNode();
    const final = engine.replay(match);
    const seats: SeatsInput = { white: { kind: "guest", name: "  Player Two  " }, black: { kind: "bot", level: "club" } };

    await expect(verifyAndStore(match, seats)).resolves.toEqual({ id: "game_1" });

    const { data } = db.game.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data).toMatchObject({ format: "match", matchLength: 5, status: "finished", botLevel: "club" });
    expect(data.seed).toBe(BigInt(7));
    const result = data.result as { winner: "white" | "black"; score: { white: number; black: number } };
    expect(result.score).toEqual(final.score);
    expect(result.score[result.winner]).toBeGreaterThanOrEqual(5);
    expect(result).toEqual({ ...final.game.result, score: final.score });
    // Guest names are trimmed before they are stored.
    expect((data.seats as { create: { guestName: string | null }[] }).create[0].guestName).toBe("Player Two");
  });

  it("takes the bot level from the bot seat whichever side it sat at, and reads it back on that seat", async () => {
    const seats: SeatsInput = { white: { kind: "bot", level: "club" }, black: { kind: "guest", name: "Player One" } };
    await expect(verifyAndStore(single, seats)).resolves.toEqual({ id: "game_1" });
    const { data } = db.game.create.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(data.botLevel).toBe("club");
    expect(data.seats).toEqual({
      create: [
        { seat: 0, userId: null, guestName: null, seatSecretHash: null },
        { seat: 1, userId: null, guestName: "Player One", seatSecretHash: null },
      ],
    });

    db.game.findUnique.mockResolvedValue({
      id: "game_1",
      token: null,
      format: "single",
      matchLength: 0,
      clockConfig: null,
      botLevel: "club",
      seed: BigInt(42),
      status: "finished",
      result: data.result,
      moveLog: single,
      createdAt: new Date("2026-09-14T10:00:00.000Z"),
      finishedAt: new Date("2026-09-14T10:05:00.000Z"),
      seats: [
        { id: "s0", gameId: "game_1", seat: 0, userId: null, guestName: null, seatSecretHash: null },
        { id: "s1", gameId: "game_1", seat: 1, userId: null, guestName: "Player One", seatSecretHash: null },
      ],
    });
    expect((await getGame("game_1"))?.seats).toEqual(seats);
  });

  it("stores only the record's known fields (extra keys are dropped, not persisted)", async () => {
    const decorated = { ...single, extra: "ignored", turns: single.turns.map((t) => ({ ...t, note: "x" })) };
    await verifyAndStore(decorated, SEATS);
    const { data } = db.game.create.mock.calls[0][0] as { data: { moveLog: GameRecord } };
    expect(data.moveLog).toEqual(single);
    expect(Object.keys(data.moveLog).sort()).toEqual(["length", "rules", "seed", "turns"]);
    expect(Object.keys(data.moveLog.turns[0]).sort()).toEqual(["action", "dice", "play", "player", "resignPoints"]);
  });
});

describe("getGame", () => {
  const row = {
    id: "game_9",
    token: null,
    format: "single",
    matchLength: 0,
    clockConfig: null,
    botLevel: "beginner",
    seed: BigInt(42),
    status: "finished",
    result: { winner: "black", kind: "single", points: 2, score: { white: 0, black: 2 } },
    moveLog: single,
    createdAt: new Date("2026-09-14T10:00:00.000Z"),
    finishedAt: new Date("2026-09-14T10:05:00.000Z"),
    seats: [
      { id: "s1", gameId: "game_9", seat: 1, userId: null, guestName: null, seatSecretHash: null },
      { id: "s0", gameId: "game_9", seat: 0, userId: null, guestName: "Player One", seatSecretHash: null },
    ],
  };

  it("returns null when there is no such game", async () => {
    db.game.findUnique.mockResolvedValue(null);
    await expect(getGame("nope")).resolves.toBeNull();
    expect(db.game.findUnique).toHaveBeenCalledWith({ where: { id: "nope" }, include: { seats: true } });
  });

  it("maps a stored row to the record, result and seats (seed as a number)", async () => {
    db.game.findUnique.mockResolvedValue(row);
    const game = await getGame("game_9");
    expect(game).toEqual({
      id: "game_9",
      format: "single",
      matchLength: 0,
      botLevel: "beginner",
      status: "finished",
      seed: 42,
      record: single,
      result: row.result,
      seats: { white: { kind: "guest", name: "Player One" }, black: { kind: "bot", level: "beginner" } },
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    });
    // Nothing a JSON route cannot serialise.
    expect(() => JSON.stringify(game)).not.toThrow();
  });

  it("reports a member's seat by user id and a bot seat by level", async () => {
    db.game.findUnique.mockResolvedValue({
      ...row,
      botLevel: "club",
      seats: [
        { id: "s0", gameId: "game_9", seat: 0, userId: "user_1", guestName: null, seatSecretHash: null },
        { id: "s1", gameId: "game_9", seat: 1, userId: null, guestName: null, seatSecretHash: null },
      ],
    });
    const game = await getGame("game_9");
    expect(game?.seats).toEqual({ white: { kind: "member", userId: "user_1" }, black: { kind: "bot", level: "club" } });
  });

  it("throws when the stored record is malformed rather than returning garbage", async () => {
    db.game.findUnique.mockResolvedValue({ ...row, moveLog: { seed: "x" } });
    await expect(getGame("game_9")).rejects.toThrow(/malformed/);
  });
});
