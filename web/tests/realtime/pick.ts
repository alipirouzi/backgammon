// The move-picking rules of the scripted players, free of any test
// framework so the Playwright e2e (plan Task 9) can import them as well as
// the Vitest suites: whose decision it is, whether the cube is available,
// and the first legal play the engine lists. Nothing here knows the rules
// beyond reading the phase the engine reports.

import type { EngineSync } from "../../src/engine/sync";
import type { GameState, MatchState, Player } from "../../src/engine/types";
import type { SeatIndex } from "../../src/realtime/protocol";

/** Seat 0 is White, seat 1 is Black (plan: domain conventions). */
export const seatOf = (player: Player): SeatIndex => (player === "white" ? 0 : 1);

export const opponentOf = (player: Player): Player => (player === "white" ? "black" : "white");

/** Who must act in `game`: the player on roll, or the opponent while a double is pending. */
export function actorOf(game: GameState): Player | null {
  if (game.onRoll === null) {
    return null;
  }
  switch (game.phase) {
    case "toRoll":
    case "toMove":
      return game.onRoll;
    case "doubled":
      return opponentOf(game.onRoll);
    default:
      return null;
  }
}

/** `GameState::can_double` plus the Crawford rule, as `selectors.cubeAvailableTo` reads it. */
export function cubeAvailable(match: MatchState, player: Player): boolean {
  const { game } = match;
  if (match.crawford || game.phase !== "toRoll" || game.onRoll !== player) {
    return false;
  }
  return game.cube.value < 64 && (game.cube.owner === null || game.cube.owner === player);
}

/**
 * The notation of the first legal play for the position — never the empty
 * play: a turn with no legal move is forfeited by the server before a client
 * ever sees it, so meeting one here is a session bug.
 */
export function pickPlay(engine: EngineSync, game: GameState): string {
  if (game.onRoll === null || game.dice === null) {
    throw new Error(`no play to pick in phase ${game.phase}`);
  }
  const plays = engine.legalPlays(game.board, game.onRoll, game.dice);
  if (plays.length === 0 || plays[0].moves.length === 0) {
    throw new Error(`${game.onRoll} is to move ${String(game.dice.hi)}-${String(game.dice.lo)} but has no legal move: the server should have forfeited the turn`);
  }
  return plays[0].notation;
}
