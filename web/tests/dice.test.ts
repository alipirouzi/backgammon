// The TypeScript port of bg-core's DiceRng (web/src/game/dice.ts) must
// produce exactly the dice stream the engine re-derives in `replay`. Oracle
// 1: the frozen first 100 rolls of seed 42 from engine/bg-core/src/dice.rs.
// Oracle 2 (when engine/bg-wasm/pkg is built): records whose roll turns come
// from this generator are accepted by the real `replay`, including the
// opening roll's winner and a tie that is re-rolled.

import { describe, expect, it } from "vitest";

import { loadEngineNode, locateBgWasmPkg } from "../src/engine/node";
import { DiceRng, seedToKeyWords } from "../src/game/dice";
import { defaultRules, openingRollTurn, rollTurn } from "../src/game/record";

// Copied verbatim from FIRST_100_ROLLS_SEED_42 in engine/bg-core/src/dice.rs.
const FIRST_100_ROLLS_SEED_42: [number, number][] = [
  [4, 4], [5, 1], [3, 3], [5, 4], [3, 1], [4, 3], [4, 3], [6, 5], [5, 1], [5, 4],
  [4, 3], [4, 2], [6, 2], [4, 3], [3, 3], [4, 3], [5, 4], [4, 1], [5, 4], [5, 2],
  [4, 1], [4, 1], [4, 3], [6, 3], [5, 3], [4, 1], [6, 1], [6, 1], [4, 2], [2, 2],
  [6, 3], [3, 2], [5, 2], [5, 1], [5, 2], [4, 1], [5, 3], [6, 2], [6, 5], [5, 2],
  [5, 5], [5, 4], [4, 1], [4, 2], [6, 5], [5, 4], [4, 1], [3, 2], [6, 3], [5, 3],
  [5, 5], [5, 1], [6, 5], [3, 1], [6, 6], [6, 3], [4, 4], [6, 2], [2, 1], [5, 4],
  [4, 2], [3, 2], [4, 2], [5, 1], [3, 3], [6, 1], [6, 6], [6, 4], [4, 4], [6, 3],
  [4, 1], [6, 1], [4, 1], [4, 4], [4, 2], [4, 4], [3, 1], [5, 5], [2, 1], [6, 3],
  [2, 1], [6, 2], [4, 3], [6, 1], [5, 2], [5, 1], [6, 1], [6, 2], [4, 1], [1, 1],
  [6, 1], [6, 3], [6, 1], [6, 1], [4, 1], [2, 1], [3, 1], [6, 4], [3, 3], [1, 1],
];

describe("DiceRng", () => {
  it("reproduces the engine's frozen first 100 rolls of seed 42", () => {
    const rng = new DiceRng(42);
    const rolls = FIRST_100_ROLLS_SEED_42.map(() => {
      const d = rng.roll();
      return [d.hi, d.lo];
    });
    expect(rolls).toEqual(FIRST_100_ROLLS_SEED_42);
  });

  it("is deterministic per seed and differs between seeds", () => {
    const a = new DiceRng(7);
    const b = new DiceRng(7);
    const c = new DiceRng(8);
    const seqA = Array.from({ length: 50 }, () => a.roll());
    const seqB = Array.from({ length: 50 }, () => b.roll());
    const seqC = Array.from({ length: 50 }, () => c.roll());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it("orders hi before lo and stays within 1..6, covering every face", () => {
    const rng = new DiceRng(1);
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      const d = rng.roll();
      expect(d.hi).toBeGreaterThanOrEqual(d.lo);
      expect(d.lo).toBeGreaterThanOrEqual(1);
      expect(d.hi).toBeLessThanOrEqual(6);
      counts[d.hi] += 1;
      counts[d.lo] += 1;
    }
    expect(counts.slice(1).every((c) => c > 800)).toBe(true);
  });

  it("accepts the whole safe-integer seed range and rejects everything else", () => {
    expect(() => new DiceRng(0)).not.toThrow();
    expect(() => new DiceRng(Number.MAX_SAFE_INTEGER)).not.toThrow();
    expect(() => new DiceRng(-1)).toThrow(/seed/);
    expect(() => new DiceRng(1.5)).toThrow(/seed/);
    expect(() => new DiceRng(2 ** 53)).toThrow(/seed/);
    expect(seedToKeyWords(42)).toHaveLength(8);
  });
});

const pkgDir = locateBgWasmPkg();

describe.skipIf(pkgDir === null)("DiceRng against the real replay", () => {
  it("produces roll turns the engine accepts for the opening and the following rolls", async () => {
    const engine = await loadEngineNode();
    let openingsWon: { white: number; black: number } = { white: 0, black: 0 };
    for (let seed = 1; seed <= 40; seed++) {
      const rng = new DiceRng(seed);
      const rules = defaultRules(0);
      const opening = openingRollTurn(rng);
      const record = { seed, length: 0, rules, turns: [opening] };
      const state = engine.replay(record);
      expect(state.game.phase).toBe("toMove");
      expect(state.game.onRoll).toBe(opening.player);
      expect(state.game.dice).toEqual(opening.dice);
      openingsWon = { ...openingsWon, [opening.player]: openingsWon[opening.player] + 1 };

      // Play the forced first move with the engine's first legal play, then
      // the opponent's roll must again match the seed.
      const plays = engine.legalPlays(state.game.board, opening.player, opening.dice!);
      const moved = {
        ...record,
        turns: [
          ...record.turns,
          { player: opening.player, dice: opening.dice, action: "move" as const, play: plays[0].notation, resignPoints: null },
        ],
      };
      const afterMove = engine.replay(moved);
      expect(afterMove.game.phase).toBe("toRoll");
      const next = afterMove.game.onRoll!;
      const second = rollTurn(next, rng.roll());
      const rolled = engine.replay({ ...moved, turns: [...moved.turns, second] });
      expect(rolled.game.dice).toEqual(second.dice);
    }
    expect(openingsWon.white).toBeGreaterThan(0);
    expect(openingsWon.black).toBeGreaterThan(0);
  });
});
