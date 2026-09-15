/**
 * Where a review gets its record from. A `local-<seed>` id is a bot game
 * played in this browser: its record is under `localStorage`
 * `bg.games.<id>` (game/local-games.ts). Any other id is a stored game and
 * comes from `GET /api/games/<id>` (`{ record, result, seats }`). The record
 * is only checked for shape here; the engine's `replay` is the real
 * validator and rejects anything the review could not step through.
 */

import { isLevel } from "@/app/play/game-options";
import type { Level, Record as GameRecord } from "@/engine/types";
import { defaultStorage, loadLocalGame, seedFromLocalGameId, type StorageLike } from "@/game/local-games";

export type ReviewSource = "local" | "server";

export interface ReviewGameData {
  id: string;
  source: ReviewSource;
  record: GameRecord;
  /** The computer's level when the source knows it (a stored game's bot seat); `null` otherwise. */
  level: Level | null;
}

export type ReviewLoad =
  | { status: "ok"; game: ReviewGameData }
  | { status: "not-found"; source: ReviewSource }
  | { status: "error"; message: string };

export interface LoadDeps {
  /** Where local games are read from; defaults to `localStorage`. */
  storage?: StorageLike | null;
  /** Replaces the global `fetch` (tests). */
  fetchFn?: typeof fetch;
}

/** `/review/<gameId>`, with `?level=` when the computer's level is known (a local id carries none). */
export function reviewHref(gameId: string, level?: Level | null): string {
  const path = `/review/${encodeURIComponent(gameId)}`;
  return level ? `${path}?level=${level}` : path;
}

export const gameApiPath = (id: string): string => `/api/games/${encodeURIComponent(id)}`;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isObject = (value: unknown): value is { [key: string]: unknown } => typeof value === "object" && value !== null;

/** The shape `Record` has on the wire, as far as the review needs before `replay` sees it. */
function looksLikeRecord(value: unknown): value is GameRecord {
  if (!isObject(value)) {
    return false;
  }
  const { seed, length, rules, turns } = value;
  return (
    typeof seed === "number" &&
    Number.isSafeInteger(seed) &&
    seed >= 0 &&
    typeof length === "number" &&
    Number.isInteger(length) &&
    isObject(rules) &&
    Array.isArray(turns) &&
    turns.every((turn) => isObject(turn) && typeof turn.player === "string" && typeof turn.action === "string")
  );
}

/** The bot seat's level in a stored game's `seats`, if any. */
function levelFromSeats(seats: unknown): Level | null {
  if (!isObject(seats)) {
    return null;
  }
  for (const side of ["black", "white"]) {
    const seat = seats[side];
    if (isObject(seat) && seat.kind === "bot" && isLevel(seat.level)) {
      return seat.level;
    }
  }
  return null;
}

async function loadServerGame(id: string, fetchFn: typeof fetch): Promise<ReviewLoad> {
  let response: Response;
  try {
    response = await fetchFn(gameApiPath(id), { headers: { accept: "application/json" } });
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
  if (response.status === 404) {
    return { status: "not-found", source: "server" };
  }
  if (!response.ok) {
    return { status: "error", message: `the games API answered ${String(response.status)}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { status: "error", message: `the games API returned no JSON: ${errorMessage(error)}` };
  }
  const record = isObject(body) ? body.record : undefined;
  if (!looksLikeRecord(record)) {
    return { status: "error", message: "the games API returned no usable record" };
  }
  return { status: "ok", game: { id, source: "server", record, level: levelFromSeats(isObject(body) ? body.seats : undefined) } };
}

/** The record to review for `id` — see the module docs for where each kind of id is looked up. */
export async function loadReviewGame(id: string, deps: LoadDeps = {}): Promise<ReviewLoad> {
  if (seedFromLocalGameId(id) !== null) {
    const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    const record = loadLocalGame(id, storage);
    return record === null ? { status: "not-found", source: "local" } : { status: "ok", game: { id, source: "local", record, level: null } };
  }
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  return loadServerGame(id, fetchFn);
}
