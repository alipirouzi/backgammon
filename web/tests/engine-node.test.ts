// Smoke test of the Node-side loader (web/src/engine/node.ts) against the
// real bg-wasm build: typed round trips through the shared marshalling
// layer plus the protocol dispatcher. Skipped (with the parity suite's
// banner already printed by engine-parity.test.ts) when pkg/ is not built;
// fails under CI like the parity suite does.

import { describe, expect, it } from "vitest";

import { loadEngineNode, loadEngineNodeDetailed, locateBgWasmPkg, type EngineSync } from "../src/engine/node";
import { dispatch } from "../src/engine/sync";
import type { Board, MatchContext } from "../src/engine/types";

const OPENING: Board = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
const MONEY: MatchContext = {
  length: 0,
  myAway: 0,
  theirAway: 0,
  crawford: false,
  postCrawford: false,
  cube: 1,
  cubeOwnerIsMe: null,
};

const pkgDir = locateBgWasmPkg();

if (pkgDir === null && process.env.CI) {
  throw new Error("engine-node: engine/bg-wasm/pkg is not built; CI must run `wasm-pack build` first");
}

describe.skipIf(pkgDir === null)("loadEngineNode", () => {
  it("loads once and reports the loader", async () => {
    const a = await loadEngineNodeDetailed();
    const b = await loadEngineNodeDetailed();
    expect(b).toBe(a);
    expect(["esm", "manual"]).toContain(a.loader);
    expect(a.pkgDir).toBe(pkgDir);
    console.info(`bg-wasm (node.ts) loaded via ${a.loader} loader`);
  });

  it("round-trips typed values through the real engine", async () => {
    const engine: EngineSync = await loadEngineNode();
    expect(engine.version()).toBe("bg-wasm 0.1.0");
    expect(engine.openingBoard()).toEqual(OPENING);

    const plays = engine.legalPlays(OPENING, "white", { hi: 3, lo: 1 });
    expect(plays.map((p) => p.notation)).toContain("8/5 6/5");
    expect(plays[0].moves[0]).toMatchObject({ from: expect.any(Number), to: expect.any(Number), hit: false });

    const after = engine.applyPlay(OPENING, "white", "8/5 6/5");
    expect(after.white[5]).toBe(2);
    expect(engine.applyPlay(OPENING, "white", plays.find((p) => p.notation === "8/5 6/5")!)).toEqual(after);

    const cube = engine.cubeAction(OPENING, "white", MONEY, "club");
    expect(cube.canDouble).toBe(true);
    expect(cube.equityDoubleDrop).toBe(1);

    const state = engine.replay({ seed: 42, length: 7, rules: { jacoby: false, beavers: false, autoDoubles: false }, turns: [] });
    expect(state.game.phase).toBe("openingRoll");
    expect(state.score).toEqual({ white: 0, black: 0 });
    expect(state.game.board).toEqual(OPENING);
  });

  it("dispatches protocol requests and surfaces engine errors as Error", async () => {
    const engine = await loadEngineNode();
    const chosen = dispatch(engine, {
      id: 1,
      type: "choosePlay",
      board: OPENING,
      onRoll: "white",
      dice: { hi: 3, lo: 1 },
      matchCtx: MONEY,
      level: "intermediate",
      seed: 1,
    });
    expect(chosen.play.notation).toBe("8/5 6/5");
    expect(chosen.candidates[0].probs.win).toBeGreaterThan(0);
    expect(chosen.candidates[0].rollout).toBeNull();

    expect(() => dispatch(engine, { id: 2, type: "legalPlays", board: OPENING, onRoll: "white", dice: { hi: 7, lo: 1 } })).toThrow(
      /invalid dice/,
    );
    expect(() => engine.applyPlay(OPENING, "white", "6/off")).toThrow(/illegal play/);
  });
});
