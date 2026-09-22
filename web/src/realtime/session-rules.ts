/**
 * The authority rules of a `GameSession` (plan: "Authority"): for one game
 * action from one seat, either the `Turn` to append to the record — dice
 * drawn from the seat's stream, the play checked against `legal_plays`,
 * the cube against `can_double` semantics, the resignation priced by the
 * rules — or the reject code and message the seat gets. Nothing here
 * mutates anything; the session commits the turn only after the engine's
 * `replay` and the store have accepted it.
 *
 * Check order mirrors what a player expects to hear first: for `roll`,
 * `move`, `double` and `resign` "not your turn" beats "wrong phase" (the
 * player on roll is the one whose phase it is); for `take` and `drop` the
 * pending double comes first — without one, nobody is "to answer".
 */

import type { EngineSync } from "@/engine/sync";
import type { GameState, MatchState, Player, Turn } from "@/engine/types";
import type { DiceRng } from "@/game/dice";
import { concededPoints, doubleTurn, dropTurn, moveTurn, opponent, resignTurn, rollTurn, takeTurn } from "@/game/record";

import type { GameActionMsg, RejectCode, SeatIndex } from "./protocol";

export type Verdict =
  | { ok: true; turn: Turn; draft: DiceRng | null }
  | { ok: false; code: RejectCode; message: string };

const PLAYER_OF_SEAT: { readonly [S in SeatIndex]: Player } = { 0: "white", 1: "black" };

export const playerOfSeat = (seat: SeatIndex): Player => PLAYER_OF_SEAT[seat];

const NAME: { readonly [P in Player]: string } = { white: "White", black: "Black" };

const reject = (code: RejectCode, message: string): Verdict => ({ ok: false, code, message });

/** Whose decision it is: the player on roll, or the opponent while a double is pending. */
export function actorOf(game: GameState): Player | null {
  if (game.onRoll === null) {
    return null;
  }
  switch (game.phase) {
    case "toRoll":
    case "toMove":
      return game.onRoll;
    case "doubled":
      return opponent(game.onRoll);
    default:
      return null;
  }
}

const notYourTurn = (game: GameState): Verdict => {
  const actor = actorOf(game);
  return reject("notYourTurn", actor === null ? "nobody is to act" : `${NAME[actor]} is to act`);
};

/** `GameState::can_double` plus the Crawford rule, as `selectors.cubeAvailableTo` reads it. */
export function cubeAvailableTo(match: MatchState, player: Player): boolean {
  const { game } = match;
  if (match.crawford || game.phase !== "toRoll" || game.onRoll !== player) {
    return false;
  }
  return game.cube.value < 64 && (game.cube.owner === null || game.cube.owner === player);
}

const hasLegalMove = (plays: { moves: unknown[] }[]): boolean => plays.length > 0 && plays.some((p) => p.moves.length > 0);

/** `true` when the player to move has no legal move for the dice: the turn is forfeited. */
export function mustForfeit(engine: EngineSync, game: GameState): boolean {
  if (game.phase !== "toMove" || game.onRoll === null || game.dice === null) {
    return false;
  }
  return !hasLegalMove(engine.legalPlays(game.board, game.onRoll, game.dice));
}

/**
 * The verdict on `msg` from `seat` in `match`. `rng` is the seat-independent
 * dice stream positioned after the last roll; a `roll` verdict carries a
 * `draft` advanced past the dice it drew, to be adopted once the turn is
 * committed.
 */
export function judge(msg: GameActionMsg, seat: SeatIndex, match: MatchState, engine: EngineSync, rng: DiceRng): Verdict {
  const player = playerOfSeat(seat);
  const { game } = match;
  switch (msg.type) {
    case "roll": {
      if (game.onRoll !== player) {
        return notYourTurn(game);
      }
      if (game.phase !== "toRoll") {
        return reject("wrongPhase", `you cannot roll while the game is in phase ${game.phase}`);
      }
      const draft = rng.clone();
      return { ok: true, turn: rollTurn(player, draft.roll()), draft };
    }
    case "move": {
      if (game.onRoll !== player) {
        return notYourTurn(game);
      }
      if (game.phase !== "toMove" || game.dice === null) {
        return reject("wrongPhase", "there are no dice to play: roll first");
      }
      const legal = engine.legalPlays(game.board, player, game.dice).map((p) => p.notation);
      if (!legal.includes(msg.play) || msg.play === "") {
        return reject("illegal", `"${msg.play}" is not a legal play for ${String(game.dice.hi)}-${String(game.dice.lo)}`);
      }
      return { ok: true, turn: moveTurn(player, game.dice, msg.play), draft: null };
    }
    case "double": {
      if (game.onRoll !== player) {
        return notYourTurn(game);
      }
      if (game.phase !== "toRoll") {
        return reject("wrongPhase", "a double must be offered before rolling");
      }
      if (!cubeAvailableTo(match, player)) {
        return reject("illegal", match.crawford ? "the cube is out of play in the Crawford game" : "the cube is not available to you");
      }
      return { ok: true, turn: doubleTurn(player), draft: null };
    }
    case "take":
    case "drop": {
      if (game.phase !== "doubled" || game.onRoll === null) {
        return reject("wrongPhase", "no double is pending");
      }
      if (opponent(game.onRoll) !== player) {
        return notYourTurn(game);
      }
      return { ok: true, turn: msg.type === "take" ? takeTurn(player) : dropTurn(player), draft: null };
    }
    case "resign": {
      if (game.onRoll !== player) {
        return notYourTurn(game);
      }
      if (game.phase !== "toRoll" && game.phase !== "toMove") {
        return reject("wrongPhase", "you can resign only on your turn, before or after rolling");
      }
      // Log what the rules award (Jacoby: a gammon at a centred cube is a single), or replay rejects the turn.
      return { ok: true, turn: resignTurn(player, concededPoints(msg.kind, game)), draft: null };
    }
    default: {
      const unknown = (msg as { type: unknown }).type;
      return reject("invalid", `unknown action ${String(unknown)}`);
    }
  }
}
