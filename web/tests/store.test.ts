// Game store (web/src/game/store.ts) driven by a scripted MockEngine: the
// record grows by exactly the turns each action implies, every state comes
// back from `replay`, the human enters moves through pending moves with
// undo, the bot chain (cube → roll → choosePlay → apply) runs after the
// human acts, cube offers are taken or dropped, finished games land in
// localStorage, and every failure ends in ui.lastError without throwing.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MockEngine } from "../src/engine/client";
import type {
  Board,
  ChosenPlay,
  CubeAnalysis,
  GameState,
  MatchState,
  MoveAnalysis,
  Play,
  Record as GameRecord,
  Turn,
} from "../src/engine/types";
import { DiceRng } from "../src/game/dice";
import { GAMES_KEY_PREFIX, LEVEL_SUFFIX, loadLocalGameLevel, THEME_KEY, type StorageLike } from "../src/game/local-games";
import { appendTurn, botSeed, moveTurn, openingRollTurn, resignTurn, rollTurn } from "../src/game/record";
import {
  analysisForTurn,
  canConfirm,
  canDouble,
  canDrop,
  canResign,
  canRetry,
  canRoll,
  canTake,
  canUndo,
  isAwaitingNextGame,
  isBotTurn,
  isHumanTurn,
  latestAnalysedSide,
  legalSources,
  legalTargetsFrom,
  pipCounts,
} from "../src/game/selectors";
import { ANALYSIS_KEY, analysisSeedFor, createGameStore, type GameStore } from "../src/game/store";

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

const OPENING: Board = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
/** Both sides bearing off: White on 6/5/4, Black on 19/20/21 (five checkers each). */
const BEAROFF: Board = {
  white: OPENING.white.map((_, i) => (i === 6 || i === 5 || i === 4 ? 5 : 0)),
  black: OPENING.black.map((_, i) => (i === 19 || i === 20 || i === 21 ? 5 : 0)),
};
const MONEY_RULES = { jacoby: true, beavers: false, autoDoubles: false };
const MATCH_RULES = { jacoby: false, beavers: false, autoDoubles: false };

function game(overrides: Partial<GameState> = {}): GameState {
  return {
    board: OPENING,
    onRoll: "white",
    dice: null,
    cube: { value: 1, owner: null },
    phase: "toRoll",
    result: null,
    rules: MONEY_RULES,
    ...overrides,
  };
}

function match(g: Partial<GameState> = {}, overrides: Partial<Omit<MatchState, "game">> = {}): MatchState {
  return {
    length: 0,
    score: { white: 0, black: 0 },
    crawford: false,
    postCrawford: false,
    game: game(g),
    ...overrides,
  };
}

const play = (notation: string, ...moves: [number, number, boolean?][]): Play => ({
  moves: moves.map(([from, to, hit = false]) => ({ from, to, hit })),
  notation,
});

const PASS: Play = { moves: [], notation: "" };

const PROBS = { win: 0.5, winG: 0.1, winBg: 0.01, loseG: 0.1, loseBg: 0.01 };
const chosen = (p: Play, ...others: Play[]): ChosenPlay => ({
  play: p,
  candidates: [p, ...others].map((c, i) => ({ play: c, equity: -i * 0.1, probs: PROBS, rollout: null })),
});
/** A club analysis over `plays` (best first, 0.03 apart) in which `plays[playedIndex]` was played. */
const analysis = (plays: Play[], playedIndex: number, withRollout = false): MoveAnalysis => {
  const errorSize = playedIndex * 0.03;
  return {
    candidates: plays.map((p, i) => ({
      play: p,
      equity: 0.1 - i * 0.03,
      probs: PROBS,
      rollout: withRollout ? { trials: 100, equity: 0.1 - i * 0.03, stdErr: 0.011, probs: PROBS } : null,
    })),
    playedIndex,
    errorSize,
    category: errorSize === 0 ? "best" : errorSize < 0.02 ? "fine" : errorSize < 0.08 ? "error" : "blunder",
  };
};
const cube = (action: CubeAnalysis["action"], canDouble = true): CubeAnalysis => ({
  action,
  canDouble,
  equityNoDouble: 0.4,
  equityDoubleTake: 0.5,
  equityDoubleDrop: 1,
  takePoint: 0.25,
});

/** Seed 42: the opening draw 4-4 is a tie, then 5-1 → White starts with 5-1. */
const SEED = 42;
const expectedOpening = openingRollTurn(new DiceRng(SEED));

function firstSeedWonBy(player: "white" | "black"): number {
  for (let seed = 1; seed < 1000; seed++) {
    if (openingRollTurn(new DiceRng(seed)).player === player) {
      return seed;
    }
  }
  throw new Error("no seed found");
}

let engine: MockEngine;
let storage: MemoryStorage;
let store: ReturnType<typeof createGameStore>;
const state = (): GameStore => store.getState();

/** Set by the tests that drive the store into an error on purpose. */
let expectError = false;

beforeEach(() => {
  expectError = false;
  engine = new MockEngine();
  storage = new MemoryStorage();
  store = createGameStore(engine, { storage });
});

// A happy-path test must never pass through the error path unnoticed.
afterEach(() => {
  if (!expectError) {
    expect(state().ui.lastError).toBeNull();
  }
});

describe("newGame", () => {
  it("logs the opening roll for its winner, replays it and loads the human's legal plays", async () => {
    expect(expectedOpening).toEqual(rollTurn("white", { hi: 5, lo: 1 }));
    let seen: GameRecord | null = null;
    engine.script("replay", (record) => {
      seen = record;
      return match({ phase: "toMove", dice: { hi: 5, lo: 1 } });
    });
    engine.script("legalPlays", [play("13/8 6/5", [13, 8], [6, 5]), play("24/18", [24, 23], [23, 18])]);

    await state().newGame({ format: "single", level: "beginner", seed: SEED });

    expect(seen).toEqual({ seed: SEED, length: 0, rules: MONEY_RULES, turns: [expectedOpening] });
    expect(state().gameId).toBe(`local-${SEED}`);
    expect(state().record?.turns).toHaveLength(1);
    expect(state().match?.game.phase).toBe("toMove");
    expect(state().seatOf).toEqual({ white: "human", black: "bot" });
    expect(state().botLevel).toBe("beginner");
    expect(engine.calls.map((c) => c.method)).toEqual(["replay", "legalPlays"]);
    expect(engine.callsTo("legalPlays")[0]).toEqual([OPENING, "white", { hi: 5, lo: 1 }]);
    expect(state().ui).toMatchObject({ selectedFrom: null, legalTargets: [], pendingMoves: [], busy: false, lastError: null });
    expect(isHumanTurn(state())).toBe(true);
    expect(canRoll(state())).toBe(false);
    expect(canResign(state())).toBe(true);
  });

  it("uses match rules and length for a match, and a fresh random seed when none is given", async () => {
    engine.always("replay", (record) => {
      expect(record.length).toBe(5);
      expect(record.rules).toEqual(MATCH_RULES);
      expect(Number.isSafeInteger(record.seed)).toBe(true);
      // The opening roll's winner is on roll; a bot win is answered by one move, then White rolls.
      return record.turns.length === 1 && record.turns[0].player === "black"
        ? match({ onRoll: "black", phase: "toMove", dice: record.turns[0].dice }, { length: 5 })
        : match({ onRoll: "white", phase: "toRoll" }, { length: 5 });
    });
    engine.always("choosePlay", chosen(play("24/21 13/9", [24, 21], [13, 9])));
    await state().newGame({ format: { matchTo: 5 }, level: "club" });
    expect(state().ui.lastError).toBeNull();
    expect(state().record?.length).toBe(5);
    expect(state().gameId).toBe(`local-${state().record?.seed}`);
    expect(canRoll(state())).toBe(true);
  });

  it("lets the bot move at once when it wins the opening roll", async () => {
    const seed = firstSeedWonBy("black");
    const opening = openingRollTurn(new DiceRng(seed));
    const botPlay = play("24/18 13/10", [24, 18], [13, 10]);
    engine.script("replay", match({ onRoll: "black", phase: "toMove", dice: opening.dice }));
    engine.script("choosePlay", chosen(botPlay, play("24/21 13/7", [24, 21], [13, 7])));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));

    await state().newGame({ format: "single", level: "intermediate", seed });

    expect(state().record?.turns).toEqual([opening, moveTurn("black", opening.dice!, "24/18 13/10")]);
    const [board, onRoll, dice, ctx, level, botSeed] = engine.callsTo("choosePlay")[0];
    expect([board, onRoll, dice, level]).toEqual([OPENING, "black", opening.dice, "intermediate"]);
    expect(ctx).toEqual({ length: 0, myAway: 0, theirAway: 0, crawford: false, postCrawford: false, cube: 1, cubeOwnerIsMe: null });
    expect(Number.isSafeInteger(botSeed)).toBe(true);
    expect(state().analysis.forBot).toMatchObject({ player: "black", dice: opening.dice, chosen: chosen(botPlay, play("24/21 13/7", [24, 21], [13, 7])) });
    expect(state().match?.game.phase).toBe("toRoll");
    expect(canRoll(state())).toBe(true);
    expect(isBotTurn(state())).toBe(false);
  });

  it("reports a rejected record in ui.lastError without throwing", async () => {
    expectError = true;
    engine.script("replay", new Error("parse error: turn 0: logged dice 5-1 but the seed gives 3-1"));
    await expect(state().newGame({ format: "single", level: "beginner", seed: SEED })).resolves.toBeUndefined();
    expect(state().ui.lastError).toMatch(/logged dice 5-1 but the seed gives 3-1/);
    expect(state().ui.busy).toBe(false);
    expect(state().match).toBeNull();
  });
});

describe("human move entry", () => {
  const PLAYS = [
    play("13/8 6/5", [13, 8], [6, 5]),
    play("13/8 24/23", [13, 8], [24, 23]),
    play("24/19 19/18", [24, 19], [19, 18]),
    play("8/3 6/5", [8, 3], [6, 5]),
  ];
  const AFTER_13_8: Board = { ...OPENING, white: OPENING.white.map((n, i) => (i === 13 ? 4 : i === 8 ? 4 : n)) };

  beforeEach(async () => {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    engine.calls.length = 0;
  });

  it("highlights the targets of a selected checker and appends the move on a target click", async () => {
    expect(legalSources(state())).toEqual([24, 13, 8, 6]);
    await state().selectPoint(13);
    expect(state().ui.selectedFrom).toBe(13);
    expect(state().ui.legalTargets).toEqual([8]);
    expect(engine.calls).toEqual([]);

    engine.script("applyPlay", AFTER_13_8);
    await state().selectPoint(8);
    expect(state().ui.pendingMoves).toEqual([{ from: 13, to: 8, hit: false }]);
    expect(state().ui.pendingBoard).toEqual(AFTER_13_8);
    expect(state().ui.selectedFrom).toBeNull();
    expect(state().ui.legalTargets).toEqual([]);
    const [board, onRoll, partial] = engine.callsTo("applyPlay")[0];
    expect(board).toEqual(OPENING);
    expect(onRoll).toBe("white");
    expect(partial).toEqual({ moves: [{ from: 13, to: 8, hit: false }] });
    // Only plays containing 13/8 remain: sources are 6 and 24 (not 8/3).
    expect(legalSources(state())).toEqual([24, 6]);
    expect(canConfirm(state())).toBe(false);
    expect(canUndo(state())).toBe(true);
  });

  it("ignores clicks that are neither a legal source nor a legal target, and toggles the selection", async () => {
    await state().selectPoint(10);
    expect(state().ui.selectedFrom).toBeNull();
    await state().selectPoint(13);
    await state().selectPoint(13);
    expect(state().ui.selectedFrom).toBeNull();
    await state().selectPoint(13);
    await state().selectPoint(20);
    expect(state().ui.selectedFrom).toBe(13);
    // Selecting another source moves the selection.
    await state().selectPoint(6);
    expect(state().ui.selectedFrom).toBe(6);
    expect(state().ui.legalTargets).toEqual([5]);
    expect(engine.calls).toEqual([]);
    expect(state().record?.turns).toHaveLength(1);
  });

  it("undoes the last pending move without asking the engine", async () => {
    engine.script("applyPlay", AFTER_13_8);
    await state().selectPoint(13);
    await state().selectPoint(8);
    const after2: Board = { ...AFTER_13_8, white: AFTER_13_8.white.map((n, i) => (i === 6 ? 4 : i === 5 ? 1 : n)) };
    engine.script("applyPlay", after2);
    await state().selectPoint(6);
    await state().selectPoint(5);
    expect(state().ui.pendingMoves).toHaveLength(2);
    expect(canConfirm(state())).toBe(true);
    expect(legalSources(state())).toEqual([]);

    state().undoPending();
    expect(state().ui.pendingMoves).toEqual([{ from: 13, to: 8, hit: false }]);
    expect(state().ui.pendingBoard).toEqual(AFTER_13_8);
    state().undoPending();
    expect(state().ui.pendingMoves).toEqual([]);
    expect(state().ui.pendingBoard).toBeNull();
    state().undoPending();
    expect(state().ui.pendingMoves).toEqual([]);
    expect(engine.callsTo("applyPlay")).toHaveLength(2);
    expect(canUndo(state())).toBe(false);
  });

  it("marks a hit from the board when the destination holds a lone opposing checker", async () => {
    // Give Black a blot on White's 5 point and offer 8/3* 6/5*-style plays.
    const board: Board = { ...OPENING, black: OPENING.black.map((n, i) => (i === 5 ? 1 : i === 12 ? 4 : n)) };
    engine.reset();
    engine.script("replay", match({ board, phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", [play("13/8 6/5*", [13, 8], [6, 5, true])]);
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    engine.script("applyPlay", board);
    await state().selectPoint(6);
    await state().selectPoint(5);
    expect(state().ui.pendingMoves).toEqual([{ from: 6, to: 5, hit: true }]);
  });

  it("confirms with the engine's notation, then runs the bot's turn (cube, roll, choosePlay, move)", async () => {
    engine.script("applyPlay", AFTER_13_8, AFTER_13_8);
    await state().selectPoint(13);
    await state().selectPoint(8);
    await state().selectPoint(24);
    expect(state().ui.legalTargets).toEqual([23]);
    await state().selectPoint(23);
    expect(canConfirm(state())).toBe(true);

    const rng = new DiceRng(SEED);
    openingRollTurn(rng);
    const botDice = rng.roll();
    const botPlay = play("24/21 13/10", [24, 21], [13, 10]);
    const records: GameRecord[] = [];
    engine.always("replay", (record) => {
      records.push(record);
      switch (record.turns.length) {
        case 2:
          return match({ onRoll: "black", phase: "toRoll" });
        case 3:
          return match({ onRoll: "black", phase: "toMove", dice: botDice });
        case 4:
          return match({ onRoll: "white", phase: "toRoll" });
        default:
          throw new Error(`unexpected replay of ${record.turns.length} turns`);
      }
    });
    engine.script("cubeAction", cube("noDouble"));
    engine.script("choosePlay", chosen(botPlay));
    engine.script("analyzePlay", analysis(PLAYS, 1));

    await state().confirmPlay();

    expect(state().ui.lastError).toBeNull();
    expect(state().record?.turns).toEqual([
      expectedOpening,
      moveTurn("white", { hi: 5, lo: 1 }, "13/8 24/23"),
      rollTurn("black", botDice),
      moveTurn("black", botDice, "24/21 13/10"),
    ]);
    expect(records).toHaveLength(3);
    // The bot answers first; the person's play is graded (analyzePlay) after the reply, so the grade never delays it.
    expect(engine.calls.map((c) => c.method)).toEqual([
      "applyPlay",
      "applyPlay",
      "replay",
      "cubeAction",
      "replay",
      "choosePlay",
      "replay",
      "analyzePlay",
    ]);
    expect(engine.callsTo("cubeAction")[0]).toEqual([
      OPENING,
      "black",
      { length: 0, myAway: 0, theirAway: 0, crawford: false, postCrawford: false, cube: 1, cubeOwnerIsMe: null },
      "beginner",
    ]);
    expect(state().analysis.forBot?.chosen.play.notation).toBe("24/21 13/10");
    expect(state().ui).toMatchObject({ pendingMoves: [], pendingBoard: null, selectedFrom: null, legalTargets: [], busy: false });
    expect(canRoll(state())).toBe(true);
    expect(canDouble(state())).toBe(true);
    expect(canUndo(state())).toBe(false);
  });

  it("does not confirm an incomplete play", async () => {
    engine.script("applyPlay", AFTER_13_8);
    await state().selectPoint(13);
    await state().selectPoint(8);
    await state().confirmPlay();
    expect(state().record?.turns).toHaveLength(1);
    expect(engine.callsTo("replay")).toHaveLength(0);
  });

  it("surfaces a failed applyPlay in ui.lastError and keeps the pending moves unchanged", async () => {
    expectError = true;
    engine.script("applyPlay", new Error("illegal play: bar first"));
    await state().selectPoint(13);
    await state().selectPoint(8);
    expect(state().ui.lastError).toMatch(/bar first/);
    expect(state().ui.pendingMoves).toEqual([]);
    expect(state().ui.busy).toBe(false);
  });
});

describe("rolling and forced passes", () => {
  beforeEach(async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    engine.calls.length = 0;
  });

  it("roll() appends the seed's next roll and loads the legal plays", async () => {
    const rng = new DiceRng(SEED);
    openingRollTurn(rng);
    const dice = rng.roll();
    engine.script("replay", match({ phase: "toMove", dice }));
    engine.script("legalPlays", [play("24/21 13/10", [24, 21], [13, 10])]);

    await state().roll();

    expect(state().record?.turns[1]).toEqual(rollTurn("white", dice));
    expect(state().match?.game.dice).toEqual(dice);
    expect(state().ui.legalPlays).toHaveLength(1);
    expect(canRoll(state())).toBe(false);
    expect(legalSources(state())).toEqual([24, 13]);
  });

  it("passes automatically when the roll has no legal move and continues with the bot", async () => {
    const rng = new DiceRng(SEED);
    openingRollTurn(rng);
    const dice = rng.roll();
    const botDice = rng.roll();
    engine.always("replay", (record) => {
      switch (record.turns.length) {
        case 2:
          return match({ phase: "toMove", dice });
        case 3:
          return match({ onRoll: "black", phase: "toRoll" });
        case 4:
          return match({ onRoll: "black", phase: "toMove", dice: botDice });
        case 5:
          return match({ onRoll: "white", phase: "toRoll" });
        default:
          throw new Error(`unexpected replay of ${record.turns.length} turns`);
      }
    });
    engine.script("legalPlays", [PASS]);
    engine.script("cubeAction", cube("noDouble"));
    engine.script("choosePlay", chosen(PASS));

    await state().roll();

    expect(state().record?.turns.slice(1)).toEqual([
      rollTurn("white", dice),
      moveTurn("white", dice, ""),
      rollTurn("black", botDice),
      moveTurn("black", botDice, ""),
    ]);
    expect(state().ui.lastError).toBeNull();
    expect(canRoll(state())).toBe(true);
  });

  it("ignores roll() when it is not the human's turn to roll", async () => {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", [play("13/8 6/5", [13, 8], [6, 5])]);
    await state().roll();
    engine.calls.length = 0;
    await state().roll();
    expect(engine.calls).toEqual([]);
    expect(state().record?.turns).toHaveLength(2);
  });

  it("rolls back the record and the dice stream when the engine rejects the roll", async () => {
    const rng = new DiceRng(SEED);
    openingRollTurn(rng);
    const dice = rng.roll();
    engine.script("replay", new Error("parse error: turn 1: logged dice mismatch"));
    await state().roll();
    expect(state().ui.lastError).toMatch(/logged dice mismatch/);
    expect(state().record?.turns).toHaveLength(1);
    expect(state().match?.game.phase).toBe("toRoll");
    // The same roll is drawn again on retry: the stream did not advance.
    engine.script("replay", match({ phase: "toMove", dice }));
    engine.script("legalPlays", [PASS]);
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("cubeAction", cube("doubleTake"));
    engine.script("replay", match({ onRoll: "black", phase: "doubled" }));
    await state().roll();
    expect(state().ui.lastError).toBeNull();
    expect(state().record?.turns[1]).toEqual(rollTurn("white", dice));
  });
});

describe("the cube", () => {
  beforeEach(async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "club", seed: SEED });
    engine.calls.length = 0;
  });

  it("the bot doubles when cubeAction says so and waits for the human", async () => {
    // Human rolls, passes (no legal play), then the bot considers the cube.
    engine.script("replay", match({ phase: "toMove", dice: { hi: 6, lo: 6 } }));
    engine.script("legalPlays", [PASS]);
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("cubeAction", cube("doubleTake"));
    engine.script("replay", match({ onRoll: "black", phase: "doubled" }));

    await state().roll();

    const turns = state().record!.turns;
    expect(turns[turns.length - 1]).toEqual({ player: "black", dice: null, action: "double", play: null, resignPoints: null });
    expect(state().match?.game.phase).toBe("doubled");
    expect(isHumanTurn(state())).toBe(true);
    expect(canTake(state())).toBe(true);
    expect(canDrop(state())).toBe(true);
    expect(canRoll(state())).toBe(false);
    expect(canResign(state())).toBe(false);
  });

  it("take() hands the cube to the human and lets the bot roll on", async () => {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 6, lo: 6 } }));
    engine.script("legalPlays", [PASS]);
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("cubeAction", cube("doubleTake"));
    engine.script("replay", match({ onRoll: "black", phase: "doubled" }));
    await state().roll();
    engine.calls.length = 0;

    const taken = { value: 2, owner: "white" as const };
    engine.script("replay", match({ onRoll: "black", phase: "toRoll", cube: taken }));
    engine.script("replay", match({ onRoll: "black", phase: "toMove", dice: { hi: 2, lo: 1 }, cube: taken }));
    engine.script("choosePlay", chosen(play("24/23 13/11", [24, 23], [13, 11])));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", cube: taken }));

    await state().take();

    const turns = state().record!.turns;
    expect(turns[turns.length - 3]).toEqual({ player: "white", dice: null, action: "take", play: null, resignPoints: null });
    // The bot owns no cube now, so it rolls without asking cubeAction.
    expect(engine.calls.map((c) => c.method)).toEqual(["replay", "replay", "choosePlay", "replay"]);
    expect(canDouble(state())).toBe(true);
    expect(canRoll(state())).toBe(true);
  });

  it("drop() ends the game, records the result and stores the record", async () => {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 6, lo: 6 } }));
    engine.script("legalPlays", [PASS]);
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("cubeAction", cube("doubleTake"));
    engine.script("replay", match({ onRoll: "black", phase: "doubled" }));
    await state().roll();

    const result = { winner: "black" as const, kind: "single" as const, points: 1 };
    engine.script("replay", match({ onRoll: null, phase: "finished", result }, { score: { white: 0, black: 1 } }));
    await state().drop();

    const turns = state().record!.turns;
    expect(turns[turns.length - 1]).toEqual({ player: "white", dice: null, action: "drop", play: null, resignPoints: null });
    expect(state().lastGameResult).toEqual(result);
    expect(state().match?.game.phase).toBe("finished");
    expect(isHumanTurn(state())).toBe(false);
    expect(canRoll(state())).toBe(false);
    const saved = storage.getItem(`${GAMES_KEY_PREFIX}local-${SEED}`);
    expect(saved).not.toBeNull();
    expect(JSON.parse(saved!)).toEqual(state().record);
  });

  it("double() asks the bot, which takes...", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "doubled" }));
    engine.script("cubeAction", cube("doubleTake"));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", cube: { value: 2, owner: "black" } }));

    await state().double();

    expect(state().record?.turns.slice(1)).toEqual([
      { player: "white", dice: null, action: "double", play: null, resignPoints: null },
      { player: "black", dice: null, action: "take", play: null, resignPoints: null },
    ]);
    // The response is judged from the doubler's side of the pre-double position.
    expect(engine.callsTo("cubeAction")[0].slice(1)).toEqual([
      "white",
      { length: 0, myAway: 0, theirAway: 0, crawford: false, postCrawford: false, cube: 1, cubeOwnerIsMe: null },
      "club",
    ]);
    expect(canRoll(state())).toBe(true);
    expect(canDouble(state())).toBe(false);
  });

  it("...or drops, finishing the game", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "doubled" }));
    engine.script("cubeAction", cube("tooGood"));
    const result = { winner: "white" as const, kind: "single" as const, points: 1 };
    engine.script("replay", match({ onRoll: null, phase: "finished", result }, { score: { white: 1, black: 0 } }));

    await state().double();

    expect(state().record?.turns.slice(1).map((t: Turn) => [t.player, t.action])).toEqual([
      ["white", "double"],
      ["black", "drop"],
    ]);
    expect(state().lastGameResult).toEqual(result);
  });

  it("refuses double() when the human does not hold the cube", async () => {
    engine.reset();
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", cube: { value: 2, owner: "black" } }));
    await state().newGame({ format: "single", level: "club", seed: SEED });
    engine.calls.length = 0;
    expect(canDouble(state())).toBe(false);
    await state().double();
    expect(engine.calls).toEqual([]);
    expect(state().record?.turns).toHaveLength(1);
  });
});

describe("resigning", () => {
  it("logs what the rules award: a gammon conceded at a centred cube under Jacoby is a single point", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    const result = { winner: "black" as const, kind: "single" as const, points: 1 };
    engine.script("replay", (record) => {
      expect(record.turns[1]).toEqual(resignTurn("white", 1));
      return match({ onRoll: null, phase: "finished", result }, { score: { white: 0, black: 1 } });
    });

    await state().resign("gammon");

    expect(state().record?.turns[1]).toEqual({ player: "white", dice: null, action: "resign", play: null, resignPoints: 1 });
    expect(state().lastGameResult).toEqual(result);
  });

  it("logs the full multiplier in a match, where the Jacoby rule does not apply", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", rules: MATCH_RULES }, { length: 5 }));
    await state().newGame({ format: { matchTo: 5 }, level: "beginner", seed: SEED });
    const result = { winner: "black" as const, kind: "backgammon" as const, points: 3 };
    engine.script("replay", match({ onRoll: null, phase: "openingRoll", rules: MATCH_RULES }, { length: 5, score: { white: 0, black: 3 } }));

    await state().resign("backgammon");

    expect(state().record?.turns[1]).toEqual(resignTurn("white", 3));
    expect(state().lastGameResult).toEqual(result);
  });

  it("logs kind × cube points and finishes", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", cube: { value: 2, owner: "white" } }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    const result = { winner: "black" as const, kind: "gammon" as const, points: 4 };
    engine.script("replay", match({ onRoll: null, phase: "finished", result, cube: { value: 2, owner: "white" } }, { score: { white: 0, black: 4 } }));

    await state().resign("gammon");

    expect(state().record?.turns[1]).toEqual({ player: "white", dice: null, action: "resign", play: null, resignPoints: 4 });
    expect(state().lastGameResult).toEqual(result);
    expect(engine.callsTo("replay")).toHaveLength(2);
  });
});

describe("matches", () => {
  it("derives the finished game's result when replay has already started the next game, then draws its opening roll", async () => {
    const rng = new DiceRng(SEED);
    const opening = openingRollTurn(rng);
    const nextOpening = openingRollTurn(rng);
    engine.script("replay", match({ board: BEAROFF, phase: "toMove", dice: opening.dice, rules: MATCH_RULES }, { length: 3 }));
    engine.script("legalPlays", [play("6/off 5/off", [6, 0], [5, 0])]);
    await state().newGame({ format: { matchTo: 3 }, level: "beginner", seed: SEED });
    const afterOne: Board = { ...BEAROFF, white: BEAROFF.white.map((n, i) => (i === 6 ? 4 : i === 25 ? 1 : n)) };
    const afterTwo: Board = { ...afterOne, white: afterOne.white.map((n, i) => (i === 5 ? 4 : i === 25 ? 2 : n)) };
    engine.script("applyPlay", afterOne, afterTwo);
    await state().selectPoint(6);
    await state().selectPoint(0);
    await state().selectPoint(5);
    await state().selectPoint(0);
    expect(canConfirm(state())).toBe(true);

    const records: GameRecord[] = [];
    engine.always("replay", (record) => {
      records.push(record);
      if (record.turns.length === 2) {
        // White won a gammon at cube 1: the score moved by 2 and a new game awaits its opening roll.
        return match({ onRoll: null, phase: "openingRoll", rules: MATCH_RULES }, { length: 3, score: { white: 2, black: 0 }, crawford: true });
      }
      return match({ onRoll: "white", phase: "toMove", dice: nextOpening.dice, rules: MATCH_RULES }, { length: 3, score: { white: 2, black: 0 }, crawford: true });
    });
    engine.script("legalPlays", [play("13/8 6/5", [13, 8], [6, 5])]);

    await state().confirmPlay();

    // The finished game's result stays on show; the next game waits for an explicit "Next game".
    expect(state().lastGameResult).toEqual({ winner: "white", kind: "gammon", points: 2 });
    expect(records.at(-1)?.turns).toEqual([opening, moveTurn("white", opening.dice!, "6/off 5/off")]);
    expect(state().match?.game.phase).toBe("openingRoll");
    expect(state().match?.score).toEqual({ white: 2, black: 0 });
    expect(isAwaitingNextGame(state())).toBe(true);
    expect(isBotTurn(state())).toBe(false);
    expect(state().ui.busy).toBe(false);

    // botTurn() (the page's automatic bot driver) must not start the next game on its own.
    engine.calls.length = 0;
    await state().botTurn();
    expect(engine.calls).toEqual([]);
    expect(records.at(-1)?.turns).toHaveLength(2);

    await state().nextGame();

    expect(isAwaitingNextGame(state())).toBe(false);
    expect(records.at(-1)?.turns).toEqual([opening, moveTurn("white", opening.dice!, "6/off 5/off"), nextOpening]);
    expect(state().lastGameResult).toEqual({ winner: "white", kind: "gammon", points: 2 });
    expect(state().match?.crawford).toBe(true);
    expect(canDouble(state())).toBe(false);
    expect(state().ui.legalPlays).toHaveLength(1);
  });

  it("does not wait after the opening roll of the very first game, nor once the match is over", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", rules: MATCH_RULES }, { length: 1 }));
    await state().newGame({ format: { matchTo: 1 }, level: "beginner", seed: SEED });
    expect(isAwaitingNextGame(state())).toBe(false);
    const result = { winner: "black" as const, kind: "single" as const, points: 1 };
    engine.script("replay", match({ onRoll: null, phase: "finished", result, rules: MATCH_RULES }, { length: 1, score: { white: 0, black: 1 } }));
    await state().resign("single");
    expect(isAwaitingNextGame(state())).toBe(false);
    expect(state().lastGameResult).toEqual(result);
    await state().nextGame();
    expect(engine.callsTo("replay")).toHaveLength(2);
  });
});

describe("bear-off entry", () => {
  /** White: one checker still on 8, fourteen home; Black: five each on 19–21. Dice 6-2. */
  const BEFORE: Board = {
    white: OPENING.white.map((_, i) => ({ 8: 1, 6: 4, 5: 3, 4: 3, 3: 2, 2: 1, 1: 1 })[i] ?? 0),
    black: OPENING.black.map((_, i) => (i === 19 || i === 20 || i === 21 ? 5 : 0)),
  };
  const AFTER_8_6: Board = { ...BEFORE, white: BEFORE.white.map((n, i) => (i === 8 ? 0 : i === 6 ? 5 : n)) };
  /** The engine's legal plays for that position (canonical order, one per resulting position). */
  const PLAYS = [
    play("8/6 6/off", [8, 6], [6, 0]),
    play("8/2 6/4", [8, 2], [6, 4]),
    play("8/2 5/3", [8, 2], [5, 3]),
    play("8/2 4/2", [8, 2], [4, 2]),
    play("8/2 3/1", [8, 2], [3, 1]),
  ];

  beforeEach(async () => {
    engine.script("replay", match({ board: BEFORE, phase: "toMove", dice: { hi: 6, lo: 2 } }));
    engine.script("legalPlays", PLAYS);
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    engine.calls.length = 0;
  });

  it("does not offer a bear-off while a checker is still outside the home board", async () => {
    // 6/off belongs to a legal play, but only after 8/6: it must not be offered first.
    expect(legalTargetsFrom(state(), 6)).toEqual([4]);
    expect(legalSources(state())).toEqual([8, 6, 5, 4, 3]);
    await state().selectPoint(6);
    expect(state().ui.legalTargets).toEqual([4]);
    await state().selectPoint(0);
    expect(state().ui.pendingMoves).toEqual([]);
    expect(engine.callsTo("applyPlay")).toHaveLength(0);
  });

  it("offers the bear-off once every checker is home", async () => {
    engine.script("applyPlay", AFTER_8_6);
    await state().selectPoint(8);
    expect(state().ui.legalTargets).toEqual([6, 2]);
    await state().selectPoint(6);
    expect(legalSources(state())).toEqual([6]);
    expect(legalTargetsFrom(state(), 6)).toEqual([0]);
    engine.script("applyPlay", { ...AFTER_8_6, white: AFTER_8_6.white.map((n, i) => (i === 6 ? 4 : i === 25 ? 1 : n)) });
    await state().selectPoint(6);
    await state().selectPoint(0);
    expect(canConfirm(state())).toBe(true);
    expect(state().ui.lastError).toBeNull();
  });
});

describe("recovering from an engine failure", () => {
  it("retryBotTurn() clears the error and plays the bot's stalled turn", async () => {
    expectError = true;
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    const rng = new DiceRng(SEED);
    openingRollTurn(rng);
    const dice = rng.roll();
    const botDice = rng.roll();
    engine.always("replay", (record) => {
      switch (record.turns.length) {
        case 2:
          return match({ phase: "toMove", dice });
        case 3:
          return match({ onRoll: "black", phase: "toRoll" });
        case 4:
          return match({ onRoll: "black", phase: "toMove", dice: botDice });
        case 5:
          return match({ onRoll: "white", phase: "toRoll" });
        default:
          throw new Error(`unexpected replay of ${record.turns.length} turns`);
      }
    });
    engine.script("legalPlays", [PASS]);
    engine.script("cubeAction", cube("noDouble"));
    engine.script("choosePlay", new Error("engine: choosePlay timed out after 10000 ms"));

    await state().roll();

    // Stalled on the bot's move: no human control is available, but a retry is.
    expect(state().ui.lastError).toMatch(/timed out/);
    expect(state().ui.busy).toBe(false);
    expect(isBotTurn(state())).toBe(true);
    expect(canRoll(state())).toBe(false);
    expect(canRetry(state())).toBe(true);
    expect(state().record?.turns).toHaveLength(4);

    engine.script("choosePlay", chosen(play("24/21 13/10", [24, 21], [13, 10])));
    await state().retryBotTurn();

    expect(state().ui.lastError).toBeNull();
    expect(canRetry(state())).toBe(false);
    expect(state().record?.turns).toHaveLength(5);
    expect(canRoll(state())).toBe(true);
  });

  it("retryBotTurn() reloads the human's legal plays when that call had failed", async () => {
    expectError = true;
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", new Error("engine worker failed"));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(state().ui.legalPlays).toBeNull();
    expect(canRetry(state())).toBe(true);

    engine.script("legalPlays", [play("13/8 6/5", [13, 8], [6, 5])]);
    await state().retryBotTurn();

    expect(state().ui.lastError).toBeNull();
    expect(state().ui.legalPlays).toHaveLength(1);
    expect(legalSources(state())).toEqual([13, 6]);
  });

  it("canRetry is false without a game to resume or while busy", async () => {
    expectError = true;
    expect(canRetry(state())).toBe(false);
    engine.script("replay", new Error("parse error: seed"));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(state().ui.lastError).toMatch(/seed/);
    expect(canRetry(state())).toBe(false);
    await state().retryBotTurn();
    expect(state().ui.lastError).toBeNull();
    expect(state().match).toBeNull();
  });
});

describe("a new game while the bot is thinking", () => {
  it("newGame wins over the in-flight chain of the previous game, whose late results are discarded", async () => {
    const seed = firstSeedWonBy("black");
    const opening = openingRollTurn(new DiceRng(seed));
    let finishBotMove: ((value: ChosenPlay) => void) | null = null;
    const slowMove = new Promise<ChosenPlay>((resolve) => {
      finishBotMove = resolve;
    });
    let botAsked: (() => void) | null = null;
    const thinking = new Promise<void>((resolve) => {
      botAsked = resolve;
    });
    engine.always("replay", (record) =>
      record.seed === seed
        ? match({ onRoll: "black", phase: "toMove", dice: opening.dice })
        : match({ onRoll: "white", phase: "toRoll" }),
    );
    engine.script("choosePlay", () => {
      botAsked!();
      return slowMove;
    });

    const first = state().newGame({ format: "single", level: "club", seed });
    await thinking; // the opening roll is committed and the computer is "thinking"
    expect(state().gameId).toBe(`local-${seed}`);
    expect(state().record?.turns).toEqual([opening]);
    expect(state().ui.busy).toBe(true);

    await state().newGame({ format: "single", level: "beginner", seed: SEED });

    expect(state().gameId).toBe(`local-${SEED}`);
    expect(state().record?.seed).toBe(SEED);
    expect(state().record?.turns).toEqual([expectedOpening]);
    expect(state().botLevel).toBe("beginner");
    expect(state().ui.busy).toBe(false);
    expect(canRoll(state())).toBe(true);
    expect(engine.callsTo("replay").map(([r]) => r.seed)).toEqual([seed, SEED]);

    // The old game's bot finally answers: nothing of it reaches the store.
    finishBotMove!(chosen(play("24/18 13/10", [24, 18], [13, 10])));
    await first;
    expect(state().gameId).toBe(`local-${SEED}`);
    expect(state().record?.turns).toEqual([expectedOpening]);
    expect(state().analysis.forBot).toBeNull();
    expect(state().ui.busy).toBe(false);
    expect(engine.callsTo("replay")).toHaveLength(2);
    expect(storage.getItem(`${GAMES_KEY_PREFIX}local-${seed}`)).not.toBeNull();
    expect(JSON.parse(storage.getItem(`${GAMES_KEY_PREFIX}local-${seed}`)!).turns).toHaveLength(1);
  });
});

describe("reopening a stored game", () => {
  const rng = new DiceRng(SEED);
  const opening = openingRollTurn(rng);
  const botDice = rng.roll();
  const secondDice = rng.roll();
  const inProgress: GameRecord = {
    seed: SEED,
    length: 0,
    rules: MONEY_RULES,
    turns: [opening, moveTurn("white", opening.dice!, "13/8 6/5"), rollTurn("black", botDice), moveTurn("black", botDice, "24/18 13/10")],
  };
  const finishedResult = { winner: "black" as const, kind: "single" as const, points: 1 };
  const finished: GameRecord = appendTurn(inProgress, rollTurn("white", secondDice), resignTurn("white", 1));
  const key = `${GAMES_KEY_PREFIX}local-${SEED}`;
  const levelKey = `${key}${LEVEL_SUFFIX}`;

  it("loads a finished record instead of starting the seed over", async () => {
    storage.setItem(key, JSON.stringify(finished));
    engine.script("replay", match({ onRoll: null, phase: "finished", result: finishedResult }, { score: { white: 0, black: 1 } }));

    await state().newGame({ format: "single", level: "beginner", seed: SEED });

    expect(engine.calls.map((c) => c.method)).toEqual(["replay"]);
    expect(engine.callsTo("replay")[0][0]).toEqual(finished);
    expect(state().record).toEqual(finished);
    expect(state().gameId).toBe(`local-${SEED}`);
    expect(state().match?.game.phase).toBe("finished");
    expect(state().lastGameResult).toEqual(finishedResult);
    expect(JSON.parse(storage.getItem(key)!)).toEqual(finished);
  });

  it("resumes an in-progress record with the dice stream in step, then plays on", async () => {
    storage.setItem(key, JSON.stringify(inProgress));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "club", seed: SEED });
    expect(state().record).toEqual(inProgress);
    expect(state().botLevel).toBe("club");
    expect(canRoll(state())).toBe(true);
    expect(JSON.parse(storage.getItem(key)!)).toEqual(inProgress);

    // The next roll is the seed's third pair — the tie of the opening roll and two rolls were skipped.
    engine.script("replay", (record) => {
      expect(record.turns[4]).toEqual(rollTurn("white", secondDice));
      return match({ phase: "toMove", dice: secondDice });
    });
    engine.script("legalPlays", [play("13/8 6/5", [13, 8], [6, 5])]);
    await state().roll();
    expect(state().ui.lastError).toBeNull();
    expect(state().record?.turns).toHaveLength(5);
    expect(JSON.parse(storage.getItem(key)!).turns).toHaveLength(5);
  });

  it("resumes into the bot's turn and lets it act", async () => {
    const stored = inProgress.turns.slice(0, 2);
    storage.setItem(key, JSON.stringify({ ...inProgress, turns: stored }));
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("cubeAction", cube("noDouble"));
    engine.script("replay", match({ onRoll: "black", phase: "toMove", dice: botDice }));
    engine.script("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10])));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));

    await state().newGame({ format: "single", level: "beginner", seed: SEED });

    expect(state().record?.turns).toEqual(inProgress.turns);
    expect(canRoll(state())).toBe(true);
  });

  it("records the level a new game starts at under bg.games.<id>.level, before anything is replayed", async () => {
    expectError = true;
    engine.script("replay", new Error("engine worker failed"));
    await state().newGame({ format: "single", level: "club", seed: SEED });
    expect(storage.getItem(levelKey)).toBe("club");
    expect(loadLocalGameLevel(`local-${SEED}`, storage)).toBe("club");
  });

  it("resumes a stored record at the level it was played at, whatever the URL says, and the bot plays at that level", async () => {
    const stored = inProgress.turns.slice(0, 2);
    storage.setItem(key, JSON.stringify({ ...inProgress, turns: stored }));
    storage.setItem(levelKey, "club");
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("cubeAction", cube("noDouble"));
    engine.script("replay", match({ onRoll: "black", phase: "toMove", dice: botDice }));
    engine.script("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10])));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));

    await state().newGame({ format: "single", level: "beginner", seed: SEED });

    expect(state().botLevel).toBe("club");
    expect(engine.callsTo("cubeAction")[0][3]).toBe("club");
    expect(engine.callsTo("choosePlay")[0][4]).toBe("club");
    expect(storage.getItem(levelKey)).toBe("club");
  });

  it("a stored record without a level (or with garbage there) takes the URL's level and records it", async () => {
    storage.setItem(key, JSON.stringify(inProgress));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "club", seed: SEED });
    expect(state().botLevel).toBe("club");
    expect(storage.getItem(levelKey)).toBe("club");

    storage.setItem(levelKey, "grandmaster");
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "intermediate", seed: SEED });
    expect(state().botLevel).toBe("intermediate");
    expect(storage.getItem(levelKey)).toBe("intermediate");
  });

  it("a finished record keeps its stored level too (what a retried post reports)", async () => {
    storage.setItem(key, JSON.stringify(finished));
    storage.setItem(levelKey, "club");
    engine.script("replay", match({ onRoll: null, phase: "finished", result: finishedResult }, { score: { white: 0, black: 1 } }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(state().botLevel).toBe("club");
    expect(state().match?.game.phase).toBe("finished");
  });

  it("the stored record decides the format: it is the game that id names", async () => {
    const stored: GameRecord = { ...inProgress, length: 5, rules: MATCH_RULES };
    storage.setItem(key, JSON.stringify(stored));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll", rules: MATCH_RULES }, { length: 5 }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(state().record).toEqual(stored);
    expect(state().match?.length).toBe(5);
  });

  it("starts afresh when the stored record is empty, and reports a record the engine rejects", async () => {
    storage.setItem(key, JSON.stringify({ ...inProgress, turns: [] }));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(state().record?.turns).toEqual([expectedOpening]);

    expectError = true;
    storage.setItem(key, JSON.stringify(inProgress));
    engine.script("replay", new Error("parse error: turn 1: illegal play"));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(state().ui.lastError).toMatch(/illegal play/);
    expect(state().record).toEqual(inProgress);
    expect(state().match).toBeNull();
    expect(JSON.parse(storage.getItem(key)!)).toEqual(inProgress);
  });

  it("reports a stored record whose rolls do not follow the seed", async () => {
    expectError = true;
    // A non-double roll that is not what the seed gives here (a double would look like an opening tie).
    const wrong = botDice.hi === 6 && botDice.lo === 1 ? { hi: 5, lo: 2 } : { hi: 6, lo: 1 };
    const drifted: GameRecord = { ...inProgress, turns: [inProgress.turns[0], inProgress.turns[1], rollTurn("black", wrong)] };
    storage.setItem(key, JSON.stringify(drifted));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(state().ui.lastError).toMatch(/seed/);
    expect(engine.calls).toEqual([]);
    expect(JSON.parse(storage.getItem(key)!)).toEqual(drifted);
  });
});

describe("botTurn, theme and storage", () => {
  it("botTurn() is a no-op unless the bot is to act", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    engine.calls.length = 0;
    await state().botTurn();
    expect(engine.calls).toEqual([]);
    await store.getState().botTurn();
    expect(state().record?.turns).toHaveLength(1);
  });

  it("botTurn() resumes a bot turn that is due", async () => {
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("legalPlays", []);
    // Simulate a store whose bot chain was interrupted: replace the match by hand.
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    store.setState({ ui: { ...state().ui, lastError: null } });
    engine.calls.length = 0;
    engine.script("cubeAction", cube("noDouble"));
    engine.script("replay", match({ onRoll: "black", phase: "toMove", dice: { hi: 4, lo: 2 } }));
    engine.script("choosePlay", chosen(play("8/4 6/4", [8, 4], [6, 4])));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().botTurn();
    expect(engine.calls.map((c) => c.method)).toEqual(["cubeAction", "replay", "choosePlay", "replay"]);
    expect(canRoll(state())).toBe(true);
  });

  it("setTheme persists under bg.theme and the initial theme is read back (invalid values fall back)", () => {
    expect(state().theme).toBe("heritage");
    state().setTheme("broadcast");
    expect(state().theme).toBe("broadcast");
    expect(storage.getItem(THEME_KEY)).toBe("broadcast");

    const reopened = createGameStore(new MockEngine(), { storage });
    expect(reopened.getState().theme).toBe("broadcast");
    storage.setItem(THEME_KEY, "neon");
    expect(createGameStore(new MockEngine(), { storage }).getState().theme).toBe("heritage");
    expect(createGameStore(new MockEngine(), { storage: null }).getState().theme).toBe("heritage");
  });

  it("saves the growing record under bg.games.<id> after every accepted turn", async () => {
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    const key = `${GAMES_KEY_PREFIX}local-${SEED}`;
    expect(JSON.parse(storage.getItem(key)!)).toEqual(appendTurn({ seed: SEED, length: 0, rules: MONEY_RULES, turns: [] }, expectedOpening));
    engine.script("replay", match({ phase: "toMove", dice: { hi: 3, lo: 3 } }));
    engine.script("legalPlays", [play("13/10(2) 6/3(2)", [13, 10], [13, 10], [6, 3], [6, 3])]);
    await state().roll();
    expect(JSON.parse(storage.getItem(key)!).turns).toHaveLength(2);
  });

  it("an engine call without a scripted response ends in ui.lastError, never a rejection", async () => {
    expectError = true;
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    await expect(state().newGame({ format: "single", level: "beginner", seed: SEED })).resolves.toBeUndefined();
    expect(state().ui.lastError).toBe("MockEngine: no scripted response for legalPlays");
    expect(state().match?.game.phase).toBe("toMove");
    expect(state().ui.busy).toBe(false);
  });
});

describe("selectors", () => {
  it("pipCounts matches the engine (opening 167/167; a bar checker counts 25)", () => {
    expect(pipCounts(OPENING)).toEqual({ white: 167, black: 167 });
    const withBar: Board = {
      white: OPENING.white.map((n, i) => (i === 24 ? 1 : i === 0 ? 1 : n)),
      black: OPENING.black.map((n, i) => (i === 1 ? 1 : i === 0 ? 1 : n)),
    };
    expect(pipCounts(withBar)).toEqual({ white: 167 - 24 + 25, black: 167 - 24 + 25 });
  });

  it("legalSources puts the bar first and only lists occupied sources", async () => {
    const board: Board = { ...OPENING, white: OPENING.white.map((n, i) => (i === 24 ? 1 : i === 0 ? 1 : n)) };
    engine.script("replay", match({ board, phase: "toMove", dice: { hi: 4, lo: 2 } }));
    engine.script("legalPlays", [play("bar/21 13/11", [25, 21], [13, 11]), play("bar/23 13/9", [25, 23], [13, 9])]);
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(legalSources(state())).toEqual([25]);
    await state().selectPoint(13);
    expect(state().ui.selectedFrom).toBeNull();
    await state().selectPoint(25);
    expect(state().ui.legalTargets).toEqual([23, 21]);
  });

  it("everything is off with no game", () => {
    const s = state();
    expect(isHumanTurn(s)).toBe(false);
    expect(isBotTurn(s)).toBe(false);
    expect(canRoll(s)).toBe(false);
    expect(canDouble(s)).toBe(false);
    expect(canTake(s)).toBe(false);
    expect(canDrop(s)).toBe(false);
    expect(canResign(s)).toBe(false);
    expect(canUndo(s)).toBe(false);
    expect(canConfirm(s)).toBe(false);
    expect(legalSources(s)).toEqual([]);
  });
});

// --- analysis (piece E, Task 7) ---------------------------------------------

describe("analysis", () => {
  const PLAYS = [
    play("13/8 6/5", [13, 8], [6, 5]),
    play("13/8 24/23", [13, 8], [24, 23]),
    play("24/19 19/18", [24, 19], [19, 18]),
  ];
  const AFTER_13_8: Board = { ...OPENING, white: OPENING.white.map((n, i) => (i === 13 ? 4 : i === 8 ? 4 : n)) };
  const AFTER_13_8_6_5: Board = { ...AFTER_13_8, white: AFTER_13_8.white.map((n, i) => (i === 6 ? 4 : i === 5 ? 1 : n)) };
  const MONEY_CTX = { length: 0, myAway: 0, theirAway: 0, crawford: false, postCrawford: false, cube: 1, cubeOwnerIsMe: null };

  /** White to move 5-1 at the opening, 13/8 6/5 entered and ready to confirm; the bot's reply is scripted. */
  async function enter13_8_6_5(): Promise<void> {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    engine.script("applyPlay", AFTER_13_8, AFTER_13_8_6_5);
    await state().selectPoint(13);
    await state().selectPoint(8);
    await state().selectPoint(6);
    await state().selectPoint(5);
    expect(canConfirm(state())).toBe(true);
    engine.calls.length = 0;
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "black", phase: "toMove", dice: { hi: 6, lo: 3 } }));
    engine.script("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10]), play("24/15", [24, 18], [18, 15])));
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "white", phase: "toRoll" }));
  }

  it("grades the confirmed play with analyzePlay on the position before the move, and caches it by turn index", async () => {
    await enter13_8_6_5();
    engine.script("analyzePlay", analysis(PLAYS, 1, true));

    await state().confirmPlay();

    expect(engine.calls.map((c) => c.method)).toEqual(["replay", "choosePlay", "replay", "analyzePlay"]);
    const [board, onRoll, dice, ctx, played, seed] = engine.callsTo("analyzePlay")[0];
    expect([board, onRoll, dice, ctx, played]).toEqual([OPENING, "white", { hi: 5, lo: 1 }, MONEY_CTX, "13/8 6/5"]);
    // The seed is the bot's derivation for the record as it stood before the move (turn index 1), so a review reproduces it.
    expect(seed).toBe(botSeed({ seed: SEED, length: 0, rules: MONEY_RULES, turns: [expectedOpening] }));
    expect(seed).toBe(analysisSeedFor(state().record!, 1));

    expect(state().analysis.forHuman).toEqual({
      turnIndex: 1,
      player: "white",
      dice: { hi: 5, lo: 1 },
      played: "13/8 6/5",
      analysis: analysis(PLAYS, 1, true),
      error: null,
    });
    expect(analysisForTurn(state(), 1)).toEqual(analysis(PLAYS, 1, true));
    expect(analysisForTurn(state(), 2)).toBeNull();
    // The bot moved after the grade: its choice is the more recent decision.
    expect(state().analysis.forBot?.turnIndex).toBe(2);
    expect(latestAnalysedSide(state())).toBe("bot");
    expect(state().ui.busy).toBe(false);
  });

  it("keeps the game going when the analysis fails, and reports the failure in the drawer only", async () => {
    await enter13_8_6_5();
    engine.script("analyzePlay", new Error("engine: analyzePlay timed out after 10000 ms"));

    await state().confirmPlay();

    expect(state().ui.lastError).toBeNull();
    expect(state().record?.turns.map((t) => t.action)).toEqual(["roll", "move", "move"]);
    expect(state().analysis.forHuman).toMatchObject({ turnIndex: 1, played: "13/8 6/5", analysis: null, error: expect.stringMatching(/timed out/) });
    expect(analysisForTurn(state(), 1)).toBeNull();
    expect(canRoll(state())).toBe(true);
  });

  it("grades after the computer's reply with the busy flag already released, and clears the previous grade at commit", async () => {
    await enter13_8_6_5();
    engine.script("analyzePlay", analysis(PLAYS, 1));
    await state().confirmPlay();
    expect(state().analysis.forHuman?.turnIndex).toBe(1);

    // Next turn: roll, enter the same play again, confirm.
    engine.script("replay", match({ board: AFTER_13_8_6_5, phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);
    await state().roll();
    engine.script("applyPlay", AFTER_13_8, AFTER_13_8_6_5);
    await state().selectPoint(13);
    await state().selectPoint(8);
    await state().selectPoint(6);
    await state().selectPoint(5);
    expect(canConfirm(state())).toBe(true);
    engine.calls.length = 0;
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "black", phase: "toMove", dice: { hi: 6, lo: 3 } }));
    engine.script("choosePlay", chosen(play("24/18 13/10", [24, 18], [13, 10])));
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "white", phase: "toRoll" }));
    let seen: { forHuman: unknown; forBotTurn: number | undefined; busy: boolean } | null = null;
    engine.script("analyzePlay", () => {
      seen = { forHuman: state().analysis.forHuman, forBotTurn: state().analysis.forBot?.turnIndex, busy: state().ui.busy };
      return analysis(PLAYS, 0);
    });

    await state().confirmPlay();

    expect(engine.calls.map((c) => c.method)).toEqual(["replay", "choosePlay", "replay", "analyzePlay"]);
    // While the grade was computed: the old grade was gone, the bot had already moved, and the table was free.
    expect(seen).toEqual({ forHuman: null, forBotTurn: 5, busy: false });
    expect(state().analysis.forHuman).toMatchObject({ turnIndex: 4, played: "13/8 6/5", analysis: analysis(PLAYS, 0) });
    expect(engine.callsTo("analyzePlay")[0][5]).toBe(analysisSeedFor(state().record!, 4));
    expect(analysisForTurn(state(), 1)).toEqual(analysis(PLAYS, 1));
    expect(analysisForTurn(state(), 4)).toEqual(analysis(PLAYS, 0));
  });

  it("does not grade a play once a newer game has taken over", async () => {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    engine.script("applyPlay", AFTER_13_8, AFTER_13_8_6_5);
    await state().selectPoint(13);
    await state().selectPoint(8);
    await state().selectPoint(6);
    await state().selectPoint(5);
    engine.script("replay", match({ board: AFTER_13_8_6_5, onRoll: "black", phase: "toMove", dice: { hi: 6, lo: 3 } }));
    // The computer is "thinking" when a new game starts; the old chain must drop everything, its grade included.
    let takeover: Promise<void> | null = null;
    engine.script("choosePlay", () => {
      takeover = state().newGame({ format: "single", level: "club", seed: SEED + 1 });
      return chosen(play("24/18 13/10", [24, 18], [13, 10]));
    });
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);

    await state().confirmPlay();
    await takeover;

    expect(state().gameId).toBe(`local-${SEED + 1}`);
    expect(state().record?.turns).toHaveLength(1);
    expect(engine.callsTo("analyzePlay")).toHaveLength(0);
    expect(state().analysis).toEqual({ forBot: null, forHuman: null, visible: true });
    expect(state().ui.busy).toBe(false);
  });

  it("does not grade a forfeited turn (no legal move), nor cube actions", async () => {
    engine.script("replay", match({ phase: "toMove", dice: { hi: 6, lo: 6 } }));
    engine.script("legalPlays", [PASS]);
    engine.script("replay", match({ onRoll: "black", phase: "toRoll" }));
    engine.script("cubeAction", cube("noDouble"));
    engine.script("replay", match({ onRoll: "black", phase: "toMove", dice: { hi: 3, lo: 1 } }));
    engine.script("choosePlay", chosen(play("8/5 6/5", [8, 5], [6, 5])));
    engine.script("replay", match({ onRoll: "white", phase: "toRoll" }));
    await state().newGame({ format: "single", level: "beginner", seed: SEED });
    expect(engine.callsTo("analyzePlay")).toHaveLength(0);
    expect(state().analysis.forHuman).toBeNull();
    expect(latestAnalysedSide(state())).toBe("bot");
  });

  it("starts a new game with the grades cleared but the drawer visibility kept", async () => {
    await enter13_8_6_5();
    engine.script("analyzePlay", analysis(PLAYS, 1));
    await state().confirmPlay();
    state().setAnalysisVisible(false);
    engine.script("replay", match({ phase: "toMove", dice: { hi: 5, lo: 1 } }));
    engine.script("legalPlays", PLAYS);

    await state().newGame({ format: "single", level: "club", seed: SEED + 1 });

    expect(state().analysis).toEqual({ forBot: null, forHuman: null, visible: false });
    expect(state().analysisByTurn).toEqual({});
  });

  it("persists the drawer visibility under bg.analysis and reads it back for the next store", () => {
    expect(state().analysis.visible).toBe(true);
    state().setAnalysisVisible(false);
    expect(storage.getItem(ANALYSIS_KEY)).toBe("0");
    expect(createGameStore(new MockEngine(), { storage }).getState().analysis.visible).toBe(false);
    state().setAnalysisVisible(true);
    expect(storage.getItem(ANALYSIS_KEY)).toBe("1");
    expect(createGameStore(new MockEngine(), { storage }).getState().analysis.visible).toBe(true);
    storage.setItem(ANALYSIS_KEY, "garbage");
    expect(createGameStore(new MockEngine(), { storage }).getState().analysis.visible).toBe(true);
    // No storage at all: on by default, and toggling does not throw.
    const detached = createGameStore(new MockEngine(), { storage: null });
    expect(detached.getState().analysis.visible).toBe(true);
    detached.getState().setAnalysisVisible(false);
    expect(detached.getState().analysis.visible).toBe(false);
  });

  it("rememberAnalysis adds a review's analysis for a turn without overwriting an existing one", () => {
    const first = analysis(PLAYS, 0);
    const second = analysis(PLAYS, 2);
    state().rememberAnalysis(4, first);
    expect(analysisForTurn(state(), 4)).toEqual(first);
    state().rememberAnalysis(4, second);
    expect(analysisForTurn(state(), 4)).toEqual(first);
    state().rememberAnalysis(6, second);
    expect(Object.keys(state().analysisByTurn)).toEqual(["4", "6"]);
  });

  it("analysisSeedFor is the bot's seed for the record cut before the turn", () => {
    const record: GameRecord = appendTurn(
      { seed: 7, length: 0, rules: MONEY_RULES, turns: [] },
      rollTurn("white", { hi: 3, lo: 1 }),
      moveTurn("white", { hi: 3, lo: 1 }, "8/5 6/5"),
      rollTurn("black", { hi: 6, lo: 2 }),
    );
    expect(analysisSeedFor(record, 1)).toBe(botSeed({ ...record, turns: record.turns.slice(0, 1) }));
    expect(analysisSeedFor(record, 3)).toBe(botSeed(record));
    expect(analysisSeedFor(record, 0)).not.toBe(analysisSeedFor(record, 1));
  });
});
