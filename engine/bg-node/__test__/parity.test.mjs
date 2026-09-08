// Parity of the native Node.js binding with the committed engine vectors
// (engine/vectors/README.md): legal plays and bot decisions must match the
// vectors exactly, records must replay, and errors must surface as
// exceptions carrying the engine's message.
//
// Every argument is passed as a JSON string (`JSON.stringify` of the vector
// field); every result is parsed back with `JSON.parse`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const engine = require("../index.js");

const vectors = (name) => JSON.parse(readFileSync(join(here, "..", "..", "vectors", name), "utf8"));
const plays = vectors("plays.json");
const decisions = vectors("decisions.json");

const EQUITY_DECIMALS = 6;

/** Rust `f64::round` (half away from zero) to six decimals; `-0` becomes `0`. */
const roundEquity = (x) => {
  const scale = 10 ** EQUITY_DECIMALS;
  return (Math.sign(x) * Math.round(Math.abs(x) * scale)) / scale + 0;
};

const call = (fn, ...args) => JSON.parse(fn(...args.map((a) => JSON.stringify(a))));

const OPENING = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
const MONEY = {
  length: 0,
  myAway: 0,
  theirAway: 0,
  crawford: false,
  postCrawford: false,
  cube: 1,
  cubeOwnerIsMe: null,
};
const MONEY_RULES = { jacoby: true, beavers: false, autoDoubles: false };

test("exports exactly the eight documented functions", () => {
  assert.deepEqual(
    Object.keys(engine).sort(),
    ["analyzePlay", "applyPlay", "choosePlay", "cubeAction", "legalPlays", "openingBoard", "replay", "version"],
  );
});

test("version() names the native binding", () => {
  assert.equal(engine.version(), "bg-node 0.1.0");
});

test("openingBoard() is the standard opening position", () => {
  assert.deepEqual(JSON.parse(engine.openingBoard()), OPENING);
});

test(`legalPlays matches every entry of plays.json (${plays.length} entries)`, () => {
  assert.equal(plays.length, 141);
  for (const [i, entry] of plays.entries()) {
    const result = call(engine.legalPlays, entry.board, entry.onRoll, entry.dice);
    assert.deepEqual(
      result.map((p) => p.notation),
      entry.plays,
      `plays.json entry ${i} (${entry.onRoll} ${entry.dice.hi}-${entry.dice.lo})`,
    );
    for (const p of result) {
      assert.ok(Array.isArray(p.moves), `entry ${i}: play has a moves array`);
    }
  }
});

test(`choosePlay matches every entry of decisions.json (${decisions.length} entries)`, () => {
  assert.equal(decisions.length, 30);
  for (const [i, entry] of decisions.entries()) {
    const result = call(
      engine.choosePlay,
      entry.board,
      entry.onRoll,
      entry.dice,
      entry.match,
      entry.level,
      entry.seed,
    );
    const label = `decisions.json entry ${i} (${entry.level}, seed ${entry.seed})`;
    assert.equal(result.play.notation, entry.chosen, `${label}: chosen play`);
    assert.deepEqual(result.play, result.candidates[0].play, `${label}: play is candidates[0]`);
    assert.deepEqual(
      result.candidates.map((c) => ({ notation: c.play.notation, equity: roundEquity(c.equity) })),
      entry.candidates,
      `${label}: candidate order and equities`,
    );
  }
});

test("choosePlay accepts the seed as a numeric string too", () => {
  const entry = decisions[0];
  const asNumber = call(engine.choosePlay, entry.board, entry.onRoll, entry.dice, entry.match, entry.level, entry.seed);
  const asString = call(engine.choosePlay, entry.board, entry.onRoll, entry.dice, entry.match, entry.level, String(entry.seed));
  assert.deepEqual(asString, asNumber);
});

test("applyPlay accepts a Play object and a notation string alike", () => {
  const [first] = call(engine.legalPlays, OPENING, "white", { hi: 3, lo: 1 });
  const byObject = call(engine.applyPlay, OPENING, "white", first);
  const byNotation = call(engine.applyPlay, OPENING, "white", first.notation);
  assert.deepEqual(byNotation, byObject);
  assert.notDeepEqual(byObject, OPENING);
  const after = call(engine.applyPlay, OPENING, "white", "8/5 6/5");
  assert.equal(after.white[5], 2);
  assert.equal(after.white[8], 2);
  assert.equal(after.white[6], 4);
  assert.deepEqual(after.black, OPENING.black);
});

test("cubeAction returns a CubeAnalysis with canDouble", () => {
  const out = call(engine.cubeAction, OPENING, "white", MONEY, "club");
  assert.ok(
    ["noDouble", "doubleTake", "doubleDrop", "tooGood", "redoubleTake", "redoubleDrop", "noRedouble"].includes(out.action),
    out.action,
  );
  assert.equal(out.canDouble, true);
  const crawford = call(engine.cubeAction, OPENING, "white", { ...MONEY, length: 5, myAway: 1, theirAway: 3, crawford: true }, "club");
  assert.equal(crawford.canDouble, false);
  assert.equal(crawford.action, "noDouble");
  assert.equal(out.equityDoubleDrop, 1);
  for (const key of ["equityNoDouble", "equityDoubleTake", "takePoint"]) {
    assert.equal(typeof out[key], "number", key);
  }
});

test("analyzePlay locates the played move and grades it", () => {
  // The played move is located by the position it produces, so a
  // non-canonical move order still matches its canonical candidate.
  const out = call(engine.analyzePlay, OPENING, "white", { hi: 3, lo: 1 }, MONEY, "24/21 24/23", 3);
  const located = out.candidates[out.playedIndex].play;
  assert.equal(located.notation, "24/23 24/21");
  assert.deepEqual(
    call(engine.applyPlay, OPENING, "white", located),
    call(engine.applyPlay, OPENING, "white", "24/21 24/23"),
  );
  assert.ok(out.errorSize >= 0);
  assert.ok(["best", "fine", "error", "blunder"].includes(out.category));
  const best = call(engine.analyzePlay, OPENING, "white", { hi: 3, lo: 1 }, MONEY, "8/5 6/5", 3);
  assert.equal(best.playedIndex, 0);
  assert.equal(best.errorSize, 0);
  assert.equal(best.category, "best");
});

test("replay of an empty record is a fresh match on the opening board", () => {
  const out = call(engine.replay, { seed: 42, length: 7, rules: MONEY_RULES, turns: [] });
  assert.equal(out.length, 7);
  assert.deepEqual(out.score, { white: 0, black: 0 });
  assert.equal(out.crawford, false);
  assert.equal(out.postCrawford, false);
  assert.equal(out.game.phase, "openingRoll");
  assert.deepEqual(out.game.board, OPENING);
});

// Seven turns of a 3-point match, generated by driving `bg_core::GameState`
// with `DiceRng::from_seed(2026)` and random legal plays; `bg_core::replay`
// of the record equals the driver's final state.
const RECORD = {
  seed: 2026,
  length: 3,
  rules: { jacoby: false, beavers: false, autoDoubles: false },
  turns: [
    { player: "white", dice: { hi: 6, lo: 1 }, action: "roll", play: null, resignPoints: null },
    { player: "white", dice: { hi: 6, lo: 1 }, action: "move", play: "13/7 7/6", resignPoints: null },
    { player: "black", dice: { hi: 6, lo: 2 }, action: "roll", play: null, resignPoints: null },
    { player: "black", dice: { hi: 6, lo: 2 }, action: "move", play: "24/18 6/4", resignPoints: null },
    { player: "white", dice: { hi: 5, lo: 3 }, action: "roll", play: null, resignPoints: null },
    { player: "white", dice: { hi: 5, lo: 3 }, action: "move", play: "8/5 8/3", resignPoints: null },
    { player: "black", dice: { hi: 6, lo: 3 }, action: "roll", play: null, resignPoints: null },
  ],
};
const RECORD_STATE = {
  length: 3,
  score: { white: 0, black: 0 },
  crawford: false,
  postCrawford: false,
  game: {
    board: {
      white: [0, 0, 0, 1, 0, 1, 6, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
      black: [0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 4, 0, 1, 0, 0, 0, 0],
    },
    onRoll: "black",
    dice: { hi: 6, lo: 3 },
    cube: { value: 1, owner: null },
    phase: "toMove",
    result: null,
    rules: { jacoby: false, beavers: false, autoDoubles: false },
  },
};

test("replay re-derives a partial record from its seed", () => {
  assert.deepEqual(call(engine.replay, RECORD), RECORD_STATE);
  // Every logged roll must agree with the seed's dice stream.
  const tampered = structuredClone(RECORD);
  tampered.turns[2].dice = { hi: 5, lo: 5 };
  assert.throws(() => call(engine.replay, tampered), /turn 2/);
});

test("errors are thrown as exceptions carrying the engine's message", () => {
  assert.throws(
    () => engine.replay(JSON.stringify({ seed: 2 ** 53, length: 1, rules: MONEY_RULES, turns: [] })),
    (e) => e instanceof Error && /exceeds the maximum 9007199254740991/.test(e.message),
  );
  assert.throws(() => engine.legalPlays("{", JSON.stringify("white"), JSON.stringify({ hi: 3, lo: 1 })), /invalid board/);
  assert.throws(() => call(engine.legalPlays, OPENING, "red", { hi: 3, lo: 1 }), /invalid player/);
  assert.throws(() => call(engine.legalPlays, OPENING, "white", { hi: 7, lo: 1 }), /invalid dice/);
  assert.throws(() => call(engine.choosePlay, OPENING, "white", { hi: 3, lo: 1 }, MONEY, "expert", 1), /invalid level/);
  assert.throws(() => call(engine.choosePlay, OPENING, "white", { hi: 3, lo: 1 }, MONEY, "club", -1), /invalid seed/);
  assert.throws(() => call(engine.applyPlay, OPENING, "white", "6/off"), /illegal play/);
});
