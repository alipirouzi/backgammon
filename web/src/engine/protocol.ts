/**
 * Request/response protocol between `client.ts` (UI thread) and `worker.ts`
 * (Web Worker running `bg-wasm`). One `Req` produces exactly one `Res` with
 * the same `id`. Shapes follow the plan (Domain and UI conventions); the
 * `version` request is added because the client exposes `version()`.
 */

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

export type Req =
  | { id: number; type: "legalPlays"; board: Board; onRoll: Player; dice: Dice }
  | { id: number; type: "applyPlay"; board: Board; onRoll: Player; play: Play | string }
  | {
      id: number;
      type: "choosePlay";
      board: Board;
      onRoll: Player;
      dice: Dice;
      matchCtx: MatchContext;
      level: Level;
      seed: number;
    }
  | { id: number; type: "cubeAction"; board: Board; onRoll: Player; matchCtx: MatchContext; level: Level }
  | {
      id: number;
      type: "analyzePlay";
      board: Board;
      onRoll: Player;
      dice: Dice;
      matchCtx: MatchContext;
      played: string;
      seed: number;
    }
  | { id: number; type: "replay"; record: GameRecord }
  | { id: number; type: "version" };

export type ReqType = Req["type"];

/** The request of a given type, without its `id` (what a caller supplies). */
export type ReqBody<T extends ReqType> = Omit<Extract<Req, { type: T }>, "id">;

/** Any request body (distributes over the union, unlike `Omit<Req, "id">`). */
export type AnyReqBody = { [T in ReqType]: ReqBody<T> }[ReqType];

/** The parsed result each request type resolves to. */
export interface ResultMap {
  legalPlays: Play[];
  applyPlay: Board;
  choosePlay: ChosenPlay;
  cubeAction: CubeAnalysis;
  analyzePlay: MoveAnalysis;
  replay: MatchState;
  version: string;
}

export type ResultFor<T extends ReqType> = ResultMap[T];

export type Res = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

/** Type guard for messages arriving from the worker. */
export function isRes(value: unknown): value is Res {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as { id?: unknown; ok?: unknown; error?: unknown };
  if (typeof v.id !== "number" || typeof v.ok !== "boolean") {
    return false;
  }
  return v.ok || typeof v.error === "string";
}
