/**
 * Contracts and small pure helpers of `GameSession` (see `session.ts`):
 * the persistence and timer interfaces the session is constructed with,
 * its options and result shapes, and the state derivations that need no
 * session — when a match is over, the result of a game `replay` has already
 * moved past.
 */

import type { EngineSync } from "@/engine/sync";
import type { GameResult, MatchState, Player, Record as GameRecord, ResultKind, Turn } from "@/engine/types";
import { resultKindFor } from "@/game/record";
import type { StoredResult } from "@/server/games";

import type { ChatLine, ResignOffer, SeatIndex, SeatInfo, ServerMsg } from "./protocol";

export type { StoredResult } from "@/server/games";

export type GameStatus = "created" | "active" | "finished" | "abandoned";

/** Persistence the session writes through; `Game.moveLog`/`status`/`result` and `ChatMessage` rows (Task 3). */
export interface SessionStore {
  saveTurns(gameId: string, record: GameRecord, status: GameStatus, result?: StoredResult): Promise<void>;
  saveChat(gameId: string, line: ChatLine): Promise<void>;
}

/** A timer the session may arm once; `setTimeout`/`clearTimeout` by default, faked in tests. */
export interface SessionTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface GameSessionOptions {
  gameId: string;
  /** The stored record; empty for a game nobody has joined yet. Must follow its seed (else the constructor throws). */
  record: GameRecord;
  /** Both seats, index 0 (White) and 1 (Black); `name` `null` while unclaimed. */
  seats: readonly SeatInfo[];
  engine: EngineSync;
  store: SessionStore;
  /** Clock in milliseconds since the epoch (chat timestamps, `lastActionAt`). */
  now: () => number;
  /** Stored status; derived from the record when omitted. A finished record is `finished` whatever is passed. */
  status?: GameStatus;
  /** Stored chat history, oldest first. */
  chat?: readonly ChatLine[];
  /** When the game last saw an action (the stored `updatedAt`-style timestamp); `now()` when omitted. Feeds the idle sweep. */
  lastActionAt?: number;
  timer?: SessionTimer;
  /** Receives broadcasts no message triggered (the next game starting on the timer). */
  onBroadcast?: (msgs: ServerMsg[]) => void;
}

export interface HandleResult {
  /** To the seat that sent the message. */
  reply: ServerMsg[];
  /** To both seats (the sender included). */
  broadcast: ServerMsg[];
}

/** How long after the first `nextGame` vote the next game of a match starts without the second. */
export const NEXT_GAME_TIMEOUT_MS = 30_000;
/** How soon the next game is tried again after its opening roll could not be stored on the timer; doubles per retry. */
export const NEXT_GAME_RETRY_MS = 5_000;
/** Retries after the timer's own failed attempt (5 s, 10 s, 20 s); then the session waits for a frame before trying again. */
export const NEXT_GAME_RETRIES = 3;
/** Chat lines kept in memory and sent in a snapshot. */
export const MAX_CHAT_HISTORY = 200;

/** One flag per seat (presence, next-game votes). */
export type SeatFlags = [boolean, boolean];

export const defaultTimer: SessionTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** `true` once nothing more can be played: a money game finished, or a match decided. */
export function isMatchOver(state: MatchState): boolean {
  if (state.game.phase !== "finished") {
    return false;
  }
  return state.length === 0 || state.score.white >= state.length || state.score.black >= state.length;
}

/**
 * The finished game's result when `replay` moved straight on to the next
 * game of a match: whoever's score grew won the points, and the kind is
 * the multiplier that produced them at the cube in force (the same
 * derivation as the bot-game store's `resultFromScore`).
 */
export function resultFromScore(before: MatchState, after: MatchState): GameResult | null {
  const players: Player[] = ["white", "black"];
  const winner = players.find((p) => after.score[p] > before.score[p]);
  if (winner === undefined) {
    return null;
  }
  const points = after.score[winner] - before.score[winner];
  return { winner, kind: resultKindFor(points, before.game.cube.value) ?? "single", points };
}

/** The two seats in index order; throws unless exactly seats 0 and 1 are given. */
export function seatsTuple(seats: readonly SeatInfo[]): [SeatInfo, SeatInfo] {
  const white = seats.find((s) => s.seat === 0);
  const black = seats.find((s) => s.seat === 1);
  if (seats.length !== 2 || white === undefined || black === undefined) {
    throw new Error("a session needs exactly seats 0 and 1");
  }
  return [white, black];
}

/** The offer `seat` makes by sending `resign { kind }`: priced by the judged resign turn (the rules, Jacoby included). */
export function resignOfferOf(seat: SeatIndex, kind: ResultKind, judged: Turn): ResignOffer {
  if (judged.action !== "resign" || judged.resignPoints === null) {
    throw new Error("a resignation offer needs a judged resign turn");
  }
  return { seat, kind, points: judged.resignPoints };
}

export const resignOfferedMsg = (offer: ResignOffer): ServerMsg => ({ type: "resignOffered", offer });

export const resignClearedMsg = (offer: ResignOffer, reason: "declined" | "withdrawn"): ServerMsg => ({ type: "resignCleared", offer, reason });
