// Parity of the WebAssembly binding (`bg-wasm`, built by wasm-pack into
// engine/bg-wasm/pkg) with the committed engine vectors
// (engine/vectors/README.md): legal plays and bot decisions must match the
// vectors exactly, records must replay, and errors must surface as `Error`s
// carrying the engine's message. The same checks run against the native
// binding in engine/bg-node/__test__/parity.test.mjs.
//
// Loading: the bundler-target `bg_wasm.js` imports `bg_wasm_bg.wasm` as an ES
// module, which Node 22+ handles natively (Vitest externalizes node_modules,
// so Node's own loader runs it). If that import fails, or when
// BG_WASM_LOADER=manual is set, the glue module is wired by hand:
// `WebAssembly.instantiate` on the `.wasm` bytes, then `__wbg_set_wasm` and
// `__wbindgen_start`, exactly as `bg_wasm.js` does. When `pkg/` is absent the
// whole suite is skipped with a banner so a local `pnpm test` passes before a
// wasm build; under `CI` (set by GitHub Actions) the file fails instead, so a
// workflow that no longer builds `pkg/` cannot pass with the binding untested
// (`pnpm install --frozen-lockfile` tolerates the missing workspace package).
//
// Every argument is passed as a JSON string (`JSON.stringify` of the vector
// field); every result is parsed back with `JSON.parse`.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, "..", "..", "engine", "vectors");

const EXPORTS = [
  "analyze_play",
  "apply_play",
  "choose_play",
  "cube_action",
  "legal_plays",
  "opening_board",
  "replay",
  "version",
] as const;

type ExportName = (typeof EXPORTS)[number];

/** The eight JSON-string functions of engine/bg-wasm/pkg/bg_wasm.d.ts. */
type Engine = Record<ExportName, (...args: string[]) => string>;

type Glue = WebAssembly.ModuleImports & {
  __wbg_set_wasm(exports: WebAssembly.Exports): void;
};

type Loader = "esm" | "manual";

interface Board {
  white: number[];
  black: number[];
}

interface Dice {
  hi: number;
  lo: number;
}

interface MatchContext {
  length: number;
  myAway: number;
  theirAway: number;
  crawford: boolean;
  postCrawford: boolean;
  cube: number;
  cubeOwnerIsMe: boolean | null;
}

interface PlayVector {
  board: Board;
  onRoll: string;
  dice: Dice;
  plays: string[];
}

interface DecisionVector {
  board: Board;
  onRoll: string;
  dice: Dice;
  match: MatchContext;
  level: string;
  seed: number;
  chosen: string;
  candidates: { notation: string; equity: number }[];
}

interface Play {
  moves: { from: number; to: number; hit: boolean }[];
  notation: string;
}

interface Candidate {
  play: Play;
  equity: number;
}

interface ChoosePlayResult {
  play: Play;
  candidates: Candidate[];
}

interface CubeAnalysis {
  action: string;
  canDouble: boolean;
  equityNoDouble: number;
  equityDoubleTake: number;
  equityDoubleDrop: number;
  takePoint: number;
}

interface MoveAnalysis {
  candidates: Candidate[];
  playedIndex: number;
  errorSize: number;
  category: string;
}

const readVectors = <T>(name: string): T[] =>
  JSON.parse(readFileSync(join(vectorsDir, name), "utf8")) as T[];

const plays = readVectors<PlayVector>("plays.json");
const decisions = readVectors<DecisionVector>("decisions.json");

const EQUITY_DECIMALS = 6;

/** Rust `f64::round` (half away from zero) to six decimals; `-0` becomes `0`. */
const roundEquity = (x: number): number => {
  const scale = 10 ** EQUITY_DECIMALS;
  return (Math.sign(x) * Math.round(Math.abs(x) * scale)) / scale + 0;
};

/** Club decisions run a 2-ply search plus rollouts; wasm is slower than native. */
const DECISION_TIMEOUT_MS = 60_000;

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
const MONEY_RULES = { jacoby: true, beavers: false, autoDoubles: false };

const CUBE_ACTIONS = [
  "noDouble",
  "doubleTake",
  "doubleDrop",
  "tooGood",
  "redoubleTake",
  "redoubleDrop",
  "noRedouble",
];

/**
 * Directory of the built `bg-wasm` package, or `null` when it is not there
 * (never built, or removed after `pnpm install` left a dangling symlink).
 */
function locatePkg(): string | null {
  try {
    const main = createRequire(import.meta.url).resolve("bg-wasm");
    return existsSync(main) ? dirname(main) : null;
  } catch {
    return null;
  }
}

function asEngine(mod: unknown): Engine {
  const record = mod as Record<string, unknown>;
  const missing = EXPORTS.filter((name) => typeof record[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`bg-wasm is missing exports: ${missing.join(", ")}`);
  }
  return mod as Engine;
}

/** The documented fallback: wire the glue module to a hand-instantiated module. */
async function loadManually(pkgDir: string): Promise<Engine> {
  const glue = (await import(pathToFileURL(join(pkgDir, "bg_wasm_bg.js")).href)) as Glue;
  const bytes = readFileSync(join(pkgDir, "bg_wasm_bg.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes, { "./bg_wasm_bg.js": glue });
  glue.__wbg_set_wasm(instance.exports);
  const start = instance.exports.__wbindgen_start;
  if (typeof start === "function") {
    start();
  }
  return asEngine(glue);
}

async function loadEngine(pkgDir: string): Promise<{ engine: Engine; loader: Loader }> {
  if (process.env.BG_WASM_LOADER !== "manual") {
    try {
      const mod: unknown = await import(pathToFileURL(join(pkgDir, "bg_wasm.js")).href);
      return { engine: asEngine(mod), loader: "esm" };
    } catch (error) {
      console.warn(
        `bg-wasm: ESM import of bg_wasm.js failed (${String(error)}); using the manual WebAssembly.instantiate loader`,
      );
    }
  }
  return { engine: await loadManually(pkgDir), loader: "manual" };
}

const pkgDir = locatePkg();

if (pkgDir === null && process.env.CI) {
  throw new Error(
    "engine-parity: engine/bg-wasm/pkg is not built; CI must run `wasm-pack build` before `pnpm install` (see .github/workflows/ci.yml)",
  );
}

if (pkgDir === null) {
  // process.stderr rather than console: Vitest's default reporter hides
  // console output, and this banner must be visible in a plain `pnpm test`.
  process.stderr.write(
    [
      "",
      "=".repeat(78),
      "  engine-parity: SKIPPED — engine/bg-wasm/pkg is not built.",
      "  Build it with:",
      "    wasm-pack build engine/bg-wasm --target bundler --release --out-dir pkg --out-name bg_wasm",
      "  then run `pnpm install` and `pnpm --filter web test` again.",
      "=".repeat(78),
      "",
      "",
    ].join("\n"),
  );
}

describe.skipIf(pkgDir === null)("bg-wasm parity with engine/vectors", () => {
  let engine: Engine;
  let loader: Loader;

  const call = <T>(fn: (...args: string[]) => string, ...args: unknown[]): T =>
    JSON.parse(fn(...args.map((a) => JSON.stringify(a)))) as T;

  beforeAll(async () => {
    if (pkgDir === null) {
      throw new Error("unreachable: suite is skipped without pkg");
    }
    ({ engine, loader } = await loadEngine(pkgDir));
    console.info(`bg-wasm loaded via ${loader} loader from ${pkgDir}`);
  });

  it("exports exactly the eight documented functions", () => {
    const names = Object.keys(engine)
      .filter((k) => !k.startsWith("__"))
      .sort();
    expect(names).toEqual([...EXPORTS].sort());
  });

  it('version() is "bg-wasm 0.1.0" as a plain string', () => {
    expect(engine.version()).toBe("bg-wasm 0.1.0");
  });

  it("opening_board() is the standard opening position", () => {
    expect(JSON.parse(engine.opening_board())).toEqual(OPENING);
  });

  describe(`legal_plays matches plays.json (${plays.length} entries)`, () => {
    it("has the documented number of entries", () => {
      expect(plays).toHaveLength(141);
    });

    for (const [i, entry] of plays.entries()) {
      it(`entry ${i}: ${entry.onRoll} ${entry.dice.hi}-${entry.dice.lo}`, () => {
        const result = call<Play[]>(engine.legal_plays, entry.board, entry.onRoll, entry.dice);
        expect(result.map((p) => p.notation)).toEqual(entry.plays);
        for (const p of result) {
          expect(Array.isArray(p.moves)).toBe(true);
        }
      });
    }
  });

  describe(`choose_play matches decisions.json (${decisions.length} entries)`, () => {
    it("has the documented number of entries", () => {
      expect(decisions).toHaveLength(30);
    });

    for (const [i, entry] of decisions.entries()) {
      it(
        `entry ${i}: ${entry.level}, seed ${entry.seed}, ${entry.onRoll} ${entry.dice.hi}-${entry.dice.lo}`,
        () => {
          const result = call<ChoosePlayResult>(
            engine.choose_play,
            entry.board,
            entry.onRoll,
            entry.dice,
            entry.match,
            entry.level,
            entry.seed,
          );
          expect(result.play.notation).toBe(entry.chosen);
          expect(result.play).toEqual(result.candidates[0].play);
          expect(
            result.candidates.map((c) => ({
              notation: c.play.notation,
              equity: roundEquity(c.equity),
            })),
          ).toEqual(entry.candidates);
        },
        DECISION_TIMEOUT_MS,
      );
    }

    it(
      "accepts the seed as a numeric string too",
      () => {
        const entry = decisions[0];
        const asNumber = call<ChoosePlayResult>(
          engine.choose_play,
          entry.board,
          entry.onRoll,
          entry.dice,
          entry.match,
          entry.level,
          entry.seed,
        );
        const asString = call<ChoosePlayResult>(
          engine.choose_play,
          entry.board,
          entry.onRoll,
          entry.dice,
          entry.match,
          entry.level,
          String(entry.seed),
        );
        expect(asString).toEqual(asNumber);
      },
      DECISION_TIMEOUT_MS,
    );
  });

  it("apply_play accepts a Play object and a notation string alike", () => {
    const [first] = call<Play[]>(engine.legal_plays, OPENING, "white", { hi: 3, lo: 1 });
    const byObject = call<Board>(engine.apply_play, OPENING, "white", first);
    const byNotation = call<Board>(engine.apply_play, OPENING, "white", first.notation);
    expect(byNotation).toEqual(byObject);
    expect(byObject).not.toEqual(OPENING);
    const after = call<Board>(engine.apply_play, OPENING, "white", "8/5 6/5");
    expect(after.white[5]).toBe(2);
    expect(after.white[8]).toBe(2);
    expect(after.white[6]).toBe(4);
    expect(after.black).toEqual(OPENING.black);
  });

  it(
    "cube_action returns a CubeAnalysis with canDouble",
    () => {
      const out = call<CubeAnalysis>(engine.cube_action, OPENING, "white", MONEY, "club");
      expect(CUBE_ACTIONS).toContain(out.action);
      expect(out.canDouble).toBe(true);
      expect(out.equityDoubleDrop).toBe(1);
      for (const key of ["equityNoDouble", "equityDoubleTake", "takePoint"] as const) {
        expect(typeof out[key]).toBe("number");
      }
      const crawford = call<CubeAnalysis>(
        engine.cube_action,
        OPENING,
        "white",
        { ...MONEY, length: 5, myAway: 1, theirAway: 3, crawford: true },
        "club",
      );
      expect(crawford.canDouble).toBe(false);
      expect(crawford.action).toBe("noDouble");
    },
    DECISION_TIMEOUT_MS,
  );

  it(
    "analyze_play locates the played move and grades it",
    () => {
      // The played move is located by the position it produces, so a
      // non-canonical move order still matches its canonical candidate.
      const out = call<MoveAnalysis>(
        engine.analyze_play,
        OPENING,
        "white",
        { hi: 3, lo: 1 },
        MONEY,
        "24/21 24/23",
        3,
      );
      const located = out.candidates[out.playedIndex].play;
      expect(located.notation).toBe("24/23 24/21");
      expect(call<Board>(engine.apply_play, OPENING, "white", located)).toEqual(
        call<Board>(engine.apply_play, OPENING, "white", "24/21 24/23"),
      );
      expect(out.errorSize).toBeGreaterThanOrEqual(0);
      expect(["best", "fine", "error", "blunder"]).toContain(out.category);
      const best = call<MoveAnalysis>(
        engine.analyze_play,
        OPENING,
        "white",
        { hi: 3, lo: 1 },
        MONEY,
        "8/5 6/5",
        3,
      );
      expect(best.playedIndex).toBe(0);
      expect(best.errorSize).toBe(0);
      expect(best.category).toBe("best");
    },
    DECISION_TIMEOUT_MS,
  );

  describe("replay", () => {
    it("of an empty record is a fresh match on the opening board", () => {
      const out = call<{
        length: number;
        score: { white: number; black: number };
        crawford: boolean;
        postCrawford: boolean;
        game: { phase: string; board: Board };
      }>(engine.replay, { seed: 42, length: 7, rules: MONEY_RULES, turns: [] });
      expect(out.length).toBe(7);
      expect(out.score).toEqual({ white: 0, black: 0 });
      expect(out.crawford).toBe(false);
      expect(out.postCrawford).toBe(false);
      expect(out.game.phase).toBe("openingRoll");
      expect(out.game.board).toEqual(OPENING);
    });

    // Seven turns of a 3-point match, generated by driving `bg_core::GameState`
    // with `DiceRng::from_seed(2026)` and random legal plays; `bg_core::replay`
    // of the record equals the driver's final state (same fixture as bg-node).
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

    it("re-derives a partial record from its seed", () => {
      expect(call(engine.replay, RECORD)).toEqual(RECORD_STATE);
      // Every logged roll must agree with the seed's dice stream.
      const tampered = structuredClone(RECORD);
      tampered.turns[2].dice = { hi: 5, lo: 5 };
      expect(() => call(engine.replay, tampered)).toThrow(/turn 2/);
    });
  });

  it("errors are thrown as Error carrying the engine's message", () => {
    expect(() =>
      engine.replay(JSON.stringify({ seed: 2 ** 53, length: 1, rules: MONEY_RULES, turns: [] })),
    ).toThrow(/exceeds the maximum 9007199254740991/);
    expect(() => engine.legal_plays("{", JSON.stringify("white"), JSON.stringify({ hi: 3, lo: 1 }))).toThrow(
      /invalid board/,
    );
    expect(() => call(engine.legal_plays, OPENING, "red", { hi: 3, lo: 1 })).toThrow(/invalid player/);
    expect(() => call(engine.legal_plays, OPENING, "white", { hi: 7, lo: 1 })).toThrow(/invalid dice/);
    expect(() => call(engine.choose_play, OPENING, "white", { hi: 3, lo: 1 }, MONEY, "expert", 1)).toThrow(
      /invalid level/,
    );
    expect(() => call(engine.choose_play, OPENING, "white", { hi: 3, lo: 1 }, MONEY, "club", -1)).toThrow(
      /invalid seed/,
    );
    expect(() => call(engine.apply_play, OPENING, "white", "6/off")).toThrow(/illegal play/);
    let thrown: unknown;
    try {
      engine.legal_plays("{", "white", "{}");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
  });
});
