/**
 * Structural validation of what the browser posts to `/api/games`: a
 * `Record` and the two seats. Only the shape is checked here — whether the
 * record is a legal game is the engine's verdict (`replay` in games.ts).
 * Every parser returns a fresh object holding only the known fields, so
 * what gets stored is exactly the documented shape and nothing a client
 * chose to add.
 */

import type { Action, Dice, Level, Player, Record as GameRecord, Rules, Turn } from "@/engine/types";
import { MAX_SEED } from "@/game/dice";

/** What a seat holds when a game is posted. */
export type SeatInput = { kind: "guest"; name: string } | { kind: "bot"; level: Level };

export interface SeatsInput {
  white: SeatInput;
  black: SeatInput;
}

/** Longest guest display name accepted (trimmed). */
export const MAX_GUEST_NAME = 40;
/** Upper bound on logged turns: a 25-point match is a few hundred; this rejects abuse, not games. */
export const MAX_TURNS = 10_000;
export const MAX_MATCH_LENGTH = 255;
/** Largest conceivable concession: a backgammon (×3) at a cube the engine could never exceed; the replay checks the exact value. */
export const MAX_RESIGN_POINTS = 3 * 2 ** 16;

const PLAYERS: readonly Player[] = ["white", "black"];
const ACTIONS: readonly Action[] = ["roll", "move", "double", "take", "drop", "resign"];
export const LEVELS: readonly Level[] = ["beginner", "intermediate", "club"];

/** Thrown by the parsers; games.ts re-throws it as `RecordInvalid`. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

type Obj = { readonly [key: string]: unknown };

function asObject(value: unknown, what: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${what} must be an object`);
  }
  return value as Obj;
}

function asInteger(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${what} must be an integer in ${min}..=${max}`);
  }
  return value;
}

function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") {
    throw new ValidationError(`${what} must be a boolean`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], what: string): T {
  if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
    throw new ValidationError(`${what} must be one of ${options.join(", ")}`);
  }
  return value as T;
}

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

function parseRules(value: unknown): Rules {
  const r = asObject(value, "rules");
  return {
    jacoby: asBoolean(r.jacoby, "rules.jacoby"),
    beavers: asBoolean(r.beavers, "rules.beavers"),
    autoDoubles: asBoolean(r.autoDoubles, "rules.autoDoubles"),
  };
}

function parseDice(value: unknown, what: string): Dice | null {
  if (value === null || value === undefined) {
    return null;
  }
  const d = asObject(value, what);
  const hi = asInteger(d.hi, `${what}.hi`, 1, 6);
  const lo = asInteger(d.lo, `${what}.lo`, 1, 6);
  if (hi < lo) {
    throw new ValidationError(`${what} must have hi >= lo`);
  }
  return { hi, lo };
}

function parseTurn(value: unknown, index: number): Turn {
  const what = `turns[${index}]`;
  const t = asObject(value, what);
  const play = t.play ?? null;
  if (play !== null && typeof play !== "string") {
    throw new ValidationError(`${what}.play must be a string or null`);
  }
  const resignPoints = t.resignPoints ?? null;
  return {
    player: oneOf(t.player, PLAYERS, `${what}.player`),
    dice: parseDice(t.dice, `${what}.dice`),
    action: oneOf(t.action, ACTIONS, `${what}.action`),
    play,
    resignPoints: resignPoints === null ? null : asInteger(resignPoints, `${what}.resignPoints`, 0, MAX_RESIGN_POINTS),
  };
}

/** A clean `Record` from untrusted input, or `ValidationError`. */
export function parseRecord(value: unknown): GameRecord {
  const r = asObject(value, "record");
  const seed = asInteger(r.seed, "seed", 0, MAX_SEED);
  const length = asInteger(r.length, "length", 0, MAX_MATCH_LENGTH);
  const rules = parseRules(r.rules);
  if (!Array.isArray(r.turns)) {
    throw new ValidationError("turns must be an array");
  }
  if (r.turns.length > MAX_TURNS) {
    throw new ValidationError(`turns must hold at most ${MAX_TURNS} entries`);
  }
  return { seed, length, rules, turns: r.turns.map(parseTurn) };
}

function parseSeat(value: unknown, what: string): SeatInput {
  const s = asObject(value, what);
  switch (s.kind) {
    case "guest": {
      const name = typeof s.name === "string" ? s.name.trim() : "";
      if (name.length === 0 || name.length > MAX_GUEST_NAME) {
        throw new ValidationError(`${what}.name must be 1..${MAX_GUEST_NAME} characters`);
      }
      return { kind: "guest", name };
    }
    case "bot":
      return { kind: "bot", level: oneOf(s.level, LEVELS, `${what}.level`) };
    default:
      throw new ValidationError(`${what}.kind must be "guest" or "bot"`);
  }
}

/**
 * Both seats from untrusted input (guest names trimmed), or `ValidationError`.
 * A bot game is one person against the computer: exactly one guest and one
 * bot, either way round. Two bots would leave one level with nowhere to go
 * (`Game.botLevel` is one column) and two guests are not a bot game at all.
 */
export function parseSeats(value: unknown): SeatsInput {
  const s = asObject(value, "seats");
  const seats = { white: parseSeat(s.white, "seats.white"), black: parseSeat(s.black, "seats.black") };
  if ((seats.white.kind === "bot") === (seats.black.kind === "bot")) {
    throw new ValidationError("seats must hold exactly one guest and one bot");
  }
  return seats;
}
