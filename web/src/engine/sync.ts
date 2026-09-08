/**
 * Synchronous, typed view of the eight JSON-string functions exported by
 * `bg-wasm` (`engine/bg-wasm/pkg/bg_wasm.d.ts`), shared by the Web Worker
 * (`worker.ts`) and the Node loader (`node.ts`). Every argument is passed as
 * `JSON.stringify` of the typed value and every result is `JSON.parse`d,
 * exactly as `web/tests/engine-parity.test.ts` drives the binding. Engine
 * errors surface as the `Error` thrown by the glue (message = Rust error
 * text); nothing is caught here.
 */

import type { Req, ReqType, ResultFor } from "./protocol";
import type {
  Board,
  ChosenPlay,
  CubeAnalysis,
  Dice,
  Level,
  MatchContext,
  MatchState,
  MoveAnalysis,
  Play,
  Player,
  Record as GameRecord,
} from "./types";

/** The raw `bg-wasm` module surface: strings in, strings out. */
export interface RawBgWasm {
  opening_board(): string;
  legal_plays(board: string, onRoll: string, dice: string): string;
  apply_play(board: string, onRoll: string, play: string): string;
  choose_play(board: string, onRoll: string, dice: string, matchCtx: string, level: string, seed: string): string;
  cube_action(board: string, onRoll: string, matchCtx: string, level: string): string;
  analyze_play(board: string, onRoll: string, dice: string, matchCtx: string, played: string, seed: string): string;
  replay(record: string): string;
  version(): string;
}

export const RAW_EXPORTS = [
  "analyze_play",
  "apply_play",
  "choose_play",
  "cube_action",
  "legal_plays",
  "opening_board",
  "replay",
  "version",
] as const satisfies readonly (keyof RawBgWasm)[];

/** Typed synchronous engine: the same methods as `Engine` without promises. */
export interface EngineSync {
  openingBoard(): Board;
  legalPlays(board: Board, onRoll: Player, dice: Dice): Play[];
  applyPlay(board: Board, onRoll: Player, play: Play | string): Board;
  choosePlay(
    board: Board,
    onRoll: Player,
    dice: Dice,
    matchCtx: MatchContext,
    level: Level,
    seed: number,
  ): ChosenPlay;
  cubeAction(board: Board, onRoll: Player, matchCtx: MatchContext, level: Level): CubeAnalysis;
  analyzePlay(
    board: Board,
    onRoll: Player,
    dice: Dice,
    matchCtx: MatchContext,
    played: string,
    seed: number,
  ): MoveAnalysis;
  replay(record: GameRecord): MatchState;
  version(): string;
}

/** Throws unless `mod` has the eight documented functions. */
export function asRawBgWasm(mod: unknown): RawBgWasm {
  const record = (mod ?? {}) as { [key: string]: unknown };
  const missing = RAW_EXPORTS.filter((name) => typeof record[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`bg-wasm is missing exports: ${missing.join(", ")}`);
  }
  return mod as RawBgWasm;
}

const j = (value: unknown): string => JSON.stringify(value);
const parse = <T>(text: string): T => JSON.parse(text) as T;

/** Wraps the raw string API in the typed synchronous interface. */
export function wrapRawEngine(raw: RawBgWasm): EngineSync {
  return {
    openingBoard: () => parse<Board>(raw.opening_board()),
    legalPlays: (board, onRoll, dice) => parse<Play[]>(raw.legal_plays(j(board), j(onRoll), j(dice))),
    applyPlay: (board, onRoll, play) => parse<Board>(raw.apply_play(j(board), j(onRoll), j(play))),
    choosePlay: (board, onRoll, dice, matchCtx, level, seed) =>
      parse<ChosenPlay>(raw.choose_play(j(board), j(onRoll), j(dice), j(matchCtx), j(level), j(seed))),
    cubeAction: (board, onRoll, matchCtx, level) =>
      parse<CubeAnalysis>(raw.cube_action(j(board), j(onRoll), j(matchCtx), j(level))),
    analyzePlay: (board, onRoll, dice, matchCtx, played, seed) =>
      parse<MoveAnalysis>(raw.analyze_play(j(board), j(onRoll), j(dice), j(matchCtx), j(played), j(seed))),
    replay: (record) => parse<MatchState>(raw.replay(j(record))),
    // `version()` returns a plain string, not JSON.
    version: () => raw.version(),
  };
}

/** Executes one protocol request against a synchronous engine. */
export function dispatch<T extends ReqType>(engine: EngineSync, req: Extract<Req, { type: T }>): ResultFor<T>;
export function dispatch(engine: EngineSync, req: Req): unknown {
  switch (req.type) {
    case "legalPlays":
      return engine.legalPlays(req.board, req.onRoll, req.dice);
    case "applyPlay":
      return engine.applyPlay(req.board, req.onRoll, req.play);
    case "choosePlay":
      return engine.choosePlay(req.board, req.onRoll, req.dice, req.matchCtx, req.level, req.seed);
    case "cubeAction":
      return engine.cubeAction(req.board, req.onRoll, req.matchCtx, req.level);
    case "analyzePlay":
      return engine.analyzePlay(req.board, req.onRoll, req.dice, req.matchCtx, req.played, req.seed);
    case "replay":
      return engine.replay(req.record);
    case "version":
      return engine.version();
    default: {
      const unknownType = (req as { type: unknown }).type;
      throw new Error(`unknown engine request type: ${String(unknownType)}`);
    }
  }
}
