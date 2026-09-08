// Record helpers (web/src/game/record.ts): building the record the engine's
// `replay` accepts — five-key Turns, the opening roll logged by its winner,
// resignation points, the bot's MatchContext, and the pending-move matching
// used by the store's move entry.

import { describe, expect, it } from "vitest";

import type { MatchState, Play, Record as GameRecord } from "../src/engine/types";
import {
  MAX_SEED,
  appendTurn,
  botSeed,
  concededPoints,
  defaultRules,
  doubleTurn,
  dropTurn,
  matchContextFor,
  moveTurn,
  movesMatchPlay,
  newRecord,
  openingRollTurn,
  opponent,
  partialPlay,
  randomSeed,
  remainingMoves,
  resignPoints,
  resignTurn,
  rollTurn,
  takeTurn,
} from "../src/game/record";

/** A stand-in generator yielding the given single-die values in order. */
function fakeRng(...dice: number[]): { rollOne(): number } {
  const queue = [...dice];
  return {
    rollOne() {
      const next = queue.shift();
      if (next === undefined) {
        throw new Error("fakeRng exhausted");
      }
      return next;
    },
  };
}

const RULES = { jacoby: false, beavers: false, autoDoubles: false };

function matchAt(overrides: Partial<MatchState> = {}): MatchState {
  return {
    length: 7,
    score: { white: 3, black: 5 },
    crawford: false,
    postCrawford: false,
    game: {
      board: { white: new Array<number>(26).fill(0), black: new Array<number>(26).fill(0) },
      onRoll: "black",
      dice: null,
      cube: { value: 2, owner: "white" },
      phase: "toRoll",
      result: null,
      rules: RULES,
    },
    ...overrides,
  };
}

describe("record construction", () => {
  it("newRecord starts empty with the rules for its length", () => {
    expect(newRecord(42, 7)).toEqual({ seed: 42, length: 7, rules: RULES, turns: [] });
    // A single (money) game uses the engine's Rules::money(): Jacoby on.
    expect(defaultRules(0)).toEqual({ jacoby: true, beavers: false, autoDoubles: false });
    expect(defaultRules(5)).toEqual(RULES);
    expect(newRecord(1, 0).rules.jacoby).toBe(true);
  });

  it("rejects seeds outside 0..MAX_SEED", () => {
    expect(MAX_SEED).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => newRecord(-1, 0)).toThrow(/seed/);
    expect(() => newRecord(2 ** 53, 0)).toThrow(/seed/);
    expect(() => newRecord(0.5, 0)).toThrow(/seed/);
  });

  it("appendTurn returns a new record and leaves the original untouched", () => {
    const base = newRecord(1, 0);
    const turn = rollTurn("white", { hi: 3, lo: 1 });
    const next = appendTurn(base, turn);
    expect(base.turns).toEqual([]);
    expect(next.turns).toEqual([turn]);
    expect(next).not.toBe(base);
    expect(next.turns).not.toBe(base.turns);
    const two = appendTurn(next, doubleTurn("black"), takeTurn("white"));
    expect(two.turns).toHaveLength(3);
  });

  it("turn builders always carry all five keys", () => {
    const keys = ["player", "dice", "action", "play", "resignPoints"].sort();
    const turns = [
      rollTurn("white", { hi: 6, lo: 2 }),
      moveTurn("black", { hi: 6, lo: 2 }, "24/18 13/11"),
      doubleTurn("white"),
      takeTurn("black"),
      dropTurn("black"),
      resignTurn("white", 4),
    ];
    for (const turn of turns) {
      expect(Object.keys(turn).sort()).toEqual(keys);
    }
    expect(rollTurn("white", { hi: 6, lo: 2 })).toEqual({
      player: "white",
      dice: { hi: 6, lo: 2 },
      action: "roll",
      play: null,
      resignPoints: null,
    });
    expect(moveTurn("black", { hi: 6, lo: 2 }, "")).toMatchObject({ action: "move", play: "" });
    expect(doubleTurn("white")).toMatchObject({ action: "double", dice: null, play: null, resignPoints: null });
    expect(takeTurn("black").action).toBe("take");
    expect(dropTurn("black").action).toBe("drop");
    expect(resignTurn("white", 4)).toMatchObject({ action: "resign", resignPoints: 4, dice: null });
  });
});

describe("openingRollTurn", () => {
  it("draws White's die first and logs the roll for the higher die's owner", () => {
    expect(openingRollTurn(fakeRng(5, 2))).toEqual(rollTurn("white", { hi: 5, lo: 2 }));
    expect(openingRollTurn(fakeRng(2, 6))).toEqual(rollTurn("black", { hi: 6, lo: 2 }));
  });

  it("re-rolls ties, consuming two dice per tie exactly as the engine does", () => {
    const rng = fakeRng(3, 3, 1, 1, 4, 6);
    expect(openingRollTurn(rng)).toEqual(rollTurn("black", { hi: 6, lo: 4 }));
    expect(() => rng.rollOne()).toThrow(/exhausted/);
  });
});

describe("match helpers", () => {
  it("resignPoints multiplies the kind by the cube", () => {
    expect(resignPoints("single", 1)).toBe(1);
    expect(resignPoints("gammon", 2)).toBe(4);
    expect(resignPoints("backgammon", 4)).toBe(12);
  });

  it("concededPoints mirrors GameState::finish: Jacoby reduces a gammon or backgammon to a single while the cube is centred", () => {
    const money = { jacoby: true, beavers: false, autoDoubles: false };
    const centred = { value: 1, owner: null };
    expect(concededPoints("gammon", { rules: money, cube: centred })).toBe(1);
    expect(concededPoints("backgammon", { rules: money, cube: centred })).toBe(1);
    expect(concededPoints("single", { rules: money, cube: centred })).toBe(1);
    // Once the cube has been turned the full multiplier applies.
    expect(concededPoints("gammon", { rules: money, cube: { value: 2, owner: "white" } })).toBe(4);
    expect(concededPoints("backgammon", { rules: money, cube: { value: 2, owner: "black" } })).toBe(6);
    // Match play has no Jacoby rule.
    expect(concededPoints("gammon", { rules: RULES, cube: centred })).toBe(2);
    expect(concededPoints("backgammon", { rules: RULES, cube: { value: 4, owner: "white" } })).toBe(12);
  });

  it("opponent flips the player", () => {
    expect(opponent("white")).toBe("black");
    expect(opponent("black")).toBe("white");
  });

  it("matchContextFor sees the match from the given player's side", () => {
    const m = matchAt();
    expect(matchContextFor(m, "black")).toEqual({
      length: 7,
      myAway: 2,
      theirAway: 4,
      crawford: false,
      postCrawford: false,
      cube: 2,
      cubeOwnerIsMe: false,
    });
    expect(matchContextFor(m, "white")).toMatchObject({ myAway: 4, theirAway: 2, cubeOwnerIsMe: true });
    const centred = matchAt({ game: { ...m.game, cube: { value: 1, owner: null } } });
    expect(matchContextFor(centred, "white").cubeOwnerIsMe).toBeNull();
    const money = matchAt({ length: 0, score: { white: 0, black: 0 } });
    expect(matchContextFor(money, "white")).toMatchObject({ length: 0, myAway: 0, theirAway: 0 });
  });

  it("randomSeed yields safe integers and botSeed derives distinct safe sub-seeds", () => {
    for (let i = 0; i < 20; i++) {
      const s = randomSeed();
      expect(Number.isSafeInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
    const record: GameRecord = appendTurn(newRecord(MAX_SEED, 0), rollTurn("white", { hi: 2, lo: 1 }));
    const a = botSeed(record);
    const b = botSeed(appendTurn(record, moveTurn("white", { hi: 2, lo: 1 }, "13/11 6/5")));
    expect(Number.isSafeInteger(a)).toBe(true);
    expect(Number.isSafeInteger(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(botSeed(record)).toBe(a);
  });
});

describe("pending-move matching", () => {
  const play: Play = {
    moves: [
      { from: 24, to: 18, hit: false },
      { from: 13, to: 10, hit: true },
    ],
    notation: "24/18 13/10*",
  };

  it("matches pending moves as a sub-multiset regardless of order and hit flags", () => {
    expect(movesMatchPlay([], play)).toBe(true);
    expect(movesMatchPlay([{ from: 13, to: 10, hit: false }], play)).toBe(true);
    expect(movesMatchPlay([{ from: 13, to: 10, hit: false }, { from: 24, to: 18, hit: false }], play)).toBe(true);
    expect(movesMatchPlay([{ from: 13, to: 11, hit: false }], play)).toBe(false);
    expect(movesMatchPlay([{ from: 13, to: 10, hit: false }, { from: 13, to: 10, hit: false }], play)).toBe(false);
  });

  it("remainingMoves lists the play's moves not yet pending, honouring duplicates", () => {
    const doubles: Play = {
      moves: [
        { from: 13, to: 7, hit: false },
        { from: 13, to: 7, hit: false },
        { from: 8, to: 2, hit: false },
      ],
      notation: "13/7(2) 8/2",
    };
    expect(remainingMoves([{ from: 13, to: 7, hit: false }], doubles)).toEqual([
      { from: 13, to: 7, hit: false },
      { from: 8, to: 2, hit: false },
    ]);
    expect(remainingMoves([], play)).toEqual(play.moves);
    expect(remainingMoves(play.moves, play)).toEqual([]);
  });

  it("partialPlay carries only the moves (the engine treats notation as optional)", () => {
    const partial = partialPlay([{ from: 13, to: 10, hit: false }]);
    expect(partial.moves).toEqual([{ from: 13, to: 10, hit: false }]);
    expect("notation" in partial).toBe(false);
  });
});
