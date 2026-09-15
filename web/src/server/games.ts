/**
 * Verify-and-store for bot games posted from the browser (plan: record
 * persistence API; spec §5.5, §8). The record is the only source of truth:
 * it is replayed by the engine in Node (`bg-wasm`), which rejects any dice
 * that do not follow the seed and any illegal play; the game must be over
 * (a single game finished, or a match decided); the result is derived from
 * the replayed state, never taken from the client. `Game` and its two
 * `GameSeat` rows are written in one atomic nested create.
 *
 * What the replay does *not* verify: the bot seat. The record says which
 * plays Black made, not that the engine's bot at the claimed level made
 * them, so a browser-posted game is replay-verified, not bot-verified —
 * `botLevel` and the bot's moves are the client's claim. The spec keeps
 * bot games out of ratings and the scoreboard (personal history only); any
 * later consumer of `botLevel` + `result` must keep that rule or add a
 * provenance flag to the schema.
 *
 * Server-only (imports `./db` and the Node engine loader).
 */

import type { GameSeat as GameSeatRow, Prisma } from "@prisma/client";

import { loadEngineNode, type EngineSync } from "@/engine/node";
import type { GameResult, Level, MatchState, Player, Record as GameRecord } from "@/engine/types";

import { getDb } from "./db";
import { isLevel, parseRecord, parseSeats, ValidationError, type SeatInput, type SeatsInput } from "./validate";

export type { SeatInput, SeatsInput } from "./validate";

/** The submitted payload cannot be stored: malformed record or seats, or the engine rejected the replay. */
export class RecordInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordInvalid";
  }
}

/** The record replays fine but the game (or match) is not over. */
export class GameNotFinished extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameNotFinished";
  }
}

/** Stored in `Game.result`: the last game's outcome plus the final score. */
export interface StoredResult extends GameResult {
  score: { white: number; black: number };
}

/** A seat as read back: guests by name, members by id (piece 5), the computer by level. */
export type SeatInfo = SeatInput | { kind: "member"; userId: string };

export interface StoredGame {
  id: string;
  format: "single" | "match";
  matchLength: number;
  botLevel: Level | null;
  status: "created" | "active" | "finished" | "abandoned";
  seed: number;
  record: GameRecord;
  result: StoredResult | null;
  seats: { white: SeatInfo; black: SeatInfo };
  createdAt: Date;
  finishedAt: Date | null;
}

/** Injection points for tests; defaults are the process-wide client and engine. */
export interface GamesDeps {
  db?: Pick<Prisma.TransactionClient, "game">;
  engine?: EngineSync;
}

const SEAT_INDEX: { readonly [P in Player]: number } = { white: 0, black: 1 };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `true` once nothing more can be played: a money game finished, or a match decided. */
export function isMatchOver(state: MatchState): boolean {
  if (state.game.phase !== "finished") {
    return false;
  }
  return state.length === 0 || state.score.white >= state.length || state.score.black >= state.length;
}

function deriveResult(state: MatchState): StoredResult {
  const last = state.game.result;
  if (last === null) {
    throw new GameNotFinished("the last game has no result");
  }
  return { ...last, score: { ...state.score } };
}

/** The level of the seat the computer played — `parseSeats` guarantees exactly one bot seat, whichever side. */
function botLevelOf(seats: SeatsInput): Level | null {
  const bot = [seats.white, seats.black].find((seat) => seat.kind === "bot");
  return bot !== undefined && bot.kind === "bot" ? bot.level : null;
}

function seatRow(seat: Player, input: SeatInput): Prisma.GameSeatCreateWithoutGameInput {
  return {
    seat: SEAT_INDEX[seat],
    userId: null,
    guestName: input.kind === "guest" ? input.name : null,
    seatSecretHash: null,
  };
}

/**
 * Replays `record` with the engine, requires the game to be over, derives
 * the result and stores the game with its seats. Resolves to the new id.
 * Throws `RecordInvalid` (bad payload or rejected replay) or
 * `GameNotFinished`; anything else is a database failure.
 */
export async function verifyAndStore(record: unknown, seats: unknown, deps: GamesDeps = {}): Promise<{ id: string }> {
  let clean: GameRecord;
  let seatInputs: SeatsInput;
  try {
    clean = parseRecord(record);
    seatInputs = parseSeats(seats);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new RecordInvalid(error.message);
    }
    throw error;
  }

  const engine = deps.engine ?? (await loadEngineNode());
  let state: MatchState;
  try {
    state = engine.replay(clean);
  } catch (error) {
    throw new RecordInvalid(`the record does not replay: ${errorMessage(error)}`);
  }
  if (!isMatchOver(state)) {
    throw new GameNotFinished(
      clean.length === 0 ? "the game is not finished" : `the match to ${clean.length} is not decided (${state.score.white}–${state.score.black})`,
    );
  }
  const result = deriveResult(state);

  const db = deps.db ?? getDb();
  // One nested create: the game and both seats are written atomically.
  const created = await db.game.create({
    data: {
      token: null,
      format: clean.length === 0 ? "single" : "match",
      matchLength: clean.length,
      botLevel: botLevelOf(seatInputs),
      seed: BigInt(clean.seed),
      status: "finished",
      result: result as unknown as Prisma.InputJsonValue,
      moveLog: clean as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
      seats: { create: [seatRow("white", seatInputs.white), seatRow("black", seatInputs.black)] },
    },
    select: { id: true },
  });
  return { id: created.id };
}

function seatInfo(row: GameSeatRow | undefined, botLevel: Level | null, seat: Player): SeatInfo {
  if (row === undefined) {
    throw new Error(`stored game is malformed: no ${seat} seat`);
  }
  if (row.userId !== null) {
    return { kind: "member", userId: row.userId };
  }
  if (row.guestName !== null) {
    return { kind: "guest", name: row.guestName };
  }
  if (botLevel !== null) {
    return { kind: "bot", level: botLevel };
  }
  throw new Error(`stored game is malformed: the ${seat} seat has no occupant`);
}

function storedRecord(value: unknown): GameRecord {
  try {
    return parseRecord(value);
  } catch (error) {
    throw new Error(`stored game is malformed: ${errorMessage(error)}`);
  }
}

/** The stored game with its record, result and seats, or `null` when `id` is unknown. */
export async function getGame(id: string, deps: GamesDeps = {}): Promise<StoredGame | null> {
  const db = deps.db ?? getDb();
  const row = await db.game.findUnique({ where: { id }, include: { seats: true } });
  if (row === null) {
    return null;
  }
  const seed = Number(row.seed);
  if (!Number.isSafeInteger(seed)) {
    throw new Error("stored game is malformed: seed exceeds 2^53 - 1");
  }
  const botLevel = isLevel(row.botLevel) ? row.botLevel : null;
  const seatFor = (player: Player): SeatInfo =>
    seatInfo(
      row.seats.find((s) => s.seat === SEAT_INDEX[player]),
      botLevel,
      player,
    );
  return {
    id: row.id,
    format: row.format,
    matchLength: row.matchLength,
    botLevel,
    status: row.status,
    seed,
    record: storedRecord(row.moveLog),
    result: row.result as StoredResult | null,
    seats: { white: seatFor("white"), black: seatFor("black") },
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  };
}
