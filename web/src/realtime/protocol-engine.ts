/**
 * zod schemas for the engine's wire shapes that travel inside realtime
 * server messages (the record in `state`/`snapshot`, `MatchState`,
 * `GameResult`). They mirror `web/src/engine/types.ts` field for field and
 * the bounds `web/src/server/validate.ts` enforces on posted records; the
 * type assertions at the bottom fail the typecheck should either side
 * drift. Shared with the browser (Task 6 parses server frames with them),
 * so nothing here may import Node modules.
 *
 * The record on the wire is `WireRecord`: the engine's `Record` with the
 * seed *optional*. The dice stream is a deterministic function of the seed
 * (`web/src/game/dice.ts`), so a live game must never reveal it — either
 * seat could otherwise list every future roll of both players. The server
 * sends the seed only once the game is over (finished or abandoned), when
 * it lets a player verify the rolls; `toWireRecord` is the one place the
 * choice is made.
 */

import { z } from "zod";

import type { Dice, GameResult, GameState, MatchState, Record as GameRecord } from "@/engine/types";
import { MAX_SEED } from "@/game/dice";
import { MAX_MATCH_LENGTH, MAX_RESIGN_POINTS, MAX_TURNS } from "@/server/validate";

/** Checkers one side can have anywhere: on a point, the bar or borne off. */
const CHECKERS_PER_SIDE = 15;
/** Slots of a `Board` side: bar, 24 points, off. */
const BOARD_SLOTS = 26;
/** `GameState::can_double` stops at 64, so no cube on the wire exceeds it. */
const MAX_CUBE = 64;

export const playerSchema = z.enum(["white", "black"]);

export const diceSchema = z
  .object({ hi: z.int().min(1).max(6), lo: z.int().min(1).max(6) })
  .refine((d) => d.hi >= d.lo, { message: "dice must have hi >= lo" }) satisfies z.ZodType<Dice>;

export const rulesSchema = z.object({ jacoby: z.boolean(), beavers: z.boolean(), autoDoubles: z.boolean() });

export const actionSchema = z.enum(["roll", "move", "double", "take", "drop", "resign"]);

export const turnSchema = z.object({
  player: playerSchema,
  dice: diceSchema.nullable(),
  action: actionSchema,
  play: z.string().nullable(),
  resignPoints: z.int().min(0).max(MAX_RESIGN_POINTS).nullable(),
});

/** The engine's `Record` as the wire carries it: the seed only once the game is over. */
export type WireRecord = Omit<GameRecord, "seed"> & { seed?: number };

export const wireRecordSchema = z.object({
  seed: z.int().min(0).max(MAX_SEED).optional(),
  length: z.int().min(0).max(MAX_MATCH_LENGTH),
  rules: rulesSchema,
  turns: z.array(turnSchema).max(MAX_TURNS),
}) satisfies z.ZodType<WireRecord>;

/** `record` for the wire: with its seed when `revealSeed` (the game is over), without it otherwise. */
export function toWireRecord(record: GameRecord, revealSeed: boolean): WireRecord {
  const { seed, ...rest } = record;
  return revealSeed ? { ...rest, seed } : rest;
}

const sideSchema = z.array(z.int().min(0).max(CHECKERS_PER_SIDE)).length(BOARD_SLOTS);

export const boardSchema = z.object({ white: sideSchema, black: sideSchema });

export const cubeSchema = z.object({ value: z.int().min(1).max(MAX_CUBE), owner: playerSchema.nullable() });

export const phaseSchema = z.enum(["openingRoll", "toRoll", "doubled", "toMove", "finished"]);

export const resultKindSchema = z.enum(["single", "gammon", "backgammon"]);

export const gameResultSchema = z.object({
  winner: playerSchema,
  kind: resultKindSchema,
  points: z.int().min(1),
}) satisfies z.ZodType<GameResult>;

export const gameStateSchema = z.object({
  board: boardSchema,
  onRoll: playerSchema.nullable(),
  dice: diceSchema.nullable(),
  cube: cubeSchema,
  phase: phaseSchema,
  result: gameResultSchema.nullable(),
  rules: rulesSchema,
}) satisfies z.ZodType<GameState>;

export const matchStateSchema = z.object({
  length: z.int().min(0).max(MAX_MATCH_LENGTH),
  score: z.object({ white: z.int().min(0), black: z.int().min(0) }),
  crawford: z.boolean(),
  postCrawford: z.boolean(),
  game: gameStateSchema,
}) satisfies z.ZodType<MatchState>;

// ---------------------------------------------------------------------------
// Drift guards: the parsed shapes and the engine's types must be the same
// type in both directions, not merely assignable one way.

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type WireRecordSchemaMatchesEngine = Assert<MutuallyAssignable<z.infer<typeof wireRecordSchema>, WireRecord>>;
/** A full record (seed included) is a valid wire record, and a wire record with a seed is a full one. */
export type FullRecordIsWireRecord = Assert<[GameRecord] extends [WireRecord] ? true : false>;
export type WireRecordWithSeedIsFull = Assert<[Required<WireRecord>] extends [GameRecord] ? true : false>;
export type MatchStateSchemaMatchesEngine = Assert<MutuallyAssignable<z.infer<typeof matchStateSchema>, MatchState>>;
export type GameResultSchemaMatchesEngine = Assert<MutuallyAssignable<z.infer<typeof gameResultSchema>, GameResult>>;
