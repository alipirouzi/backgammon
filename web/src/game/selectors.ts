/**
 * Pure read-only views of the game store for components: whose turn it is,
 * which actions the action bar may offer, which checkers may be picked up,
 * and the pip counts. None of these decide legality — they read the phase
 * the engine returned and the legal plays it listed.
 */

import type { Board, Move, Phase, Player, ResultKind } from "@/engine/types";

import { concededPoints, movesMatchPlay, opponent, remainingMoves, resignPoints } from "./record";
import type { GameStoreState } from "./store";

/** Highest point of the home board in relative numbering. */
const HOME_TOP = 6;

/** `Board::pip_count` for both sides (a bar checker counts 25). */
export function pipCounts(board: Board): { white: number; black: number } {
  const count = (checkers: number[], distance: (point: number) => number): number => {
    let pips = checkers[0] * 25;
    for (let point = 1; point <= 24; point++) {
      pips += checkers[point] * distance(point);
    }
    return pips;
  };
  return {
    white: count(board.white, (p) => p),
    black: count(board.black, (p) => 25 - p),
  };
}

/** Relative point (`25` bar, `0` off, else `1..24`) → absolute `Board` slot. */
export function toAbsolute(player: Player, relative: number): number {
  if (relative === 25) {
    return 0;
  }
  if (relative === 0) {
    return 25;
  }
  return player === "white" ? relative : 25 - relative;
}

/** Absolute point `1..24` → the point as `player` numbers it. */
export function toRelative(player: Player, absolute: number): number {
  return player === "white" ? absolute : 25 - absolute;
}

/** The seat the person plays, or `null` in a bot-versus-bot store. */
export function humanPlayer(s: GameStoreState): Player | null {
  if (s.seatOf.white === "human") {
    return "white";
  }
  return s.seatOf.black === "human" ? "black" : null;
}

/** Who must act now: the player on roll, or the opponent while a double is pending. */
export function playerToAct(s: GameStoreState): Player | null {
  const g = s.match?.game;
  if (!g || g.onRoll === null) {
    return null;
  }
  switch (g.phase) {
    case "toRoll":
    case "toMove":
      return g.onRoll;
    case "doubled":
      return opponent(g.onRoll);
    default:
      return null;
  }
}

export function isHumanTurn(s: GameStoreState): boolean {
  const actor = playerToAct(s);
  return actor !== null && s.seatOf[actor] === "human";
}

export function isBotTurn(s: GameStoreState): boolean {
  const actor = playerToAct(s);
  return actor !== null && s.seatOf[actor] === "bot";
}

export function isGameFinished(s: GameStoreState): boolean {
  return s.match?.game.phase === "finished";
}

/**
 * A game of a match has just finished and its result is on show: the next
 * game's opening roll waits for `nextGame()`. Never `true` in a money game
 * or once the match is over (the finished game stays as `match.game` then).
 */
export function isAwaitingNextGame(s: GameStoreState): boolean {
  return s.awaitingNextGame;
}

/**
 * Something is due that needs no decision from the person: the bot's turn,
 * the opening roll, or legal plays still to load for whoever is to move
 * (a failed load leaves them `null`). `botTurn()` and `retryBotTurn()` run
 * exactly these. Not while the finished game of a match is on show.
 */
export function automaticActionDue(s: GameStoreState): boolean {
  const g = s.match?.game;
  if (!g || s.awaitingNextGame) {
    return false;
  }
  return isBotTurn(s) || g.phase === "openingRoll" || (g.phase === "toMove" && s.ui.legalPlays === null);
}

/** The last action failed and there is a game to pick up again (`retryBotTurn()`). */
export function canRetry(s: GameStoreState): boolean {
  return s.ui.lastError !== null && !s.ui.busy && s.match !== null;
}

/** What resigning as `kind` would concede now — the points the rules award (Jacoby included). */
export function concededPointsFor(s: GameStoreState, kind: ResultKind): number {
  const g = s.match?.game;
  return g ? concededPoints(kind, g) : resignPoints(kind, 1);
}

/** `true` once the match is decided (a money game: once its single game is finished). */
export function isMatchOver(s: GameStoreState): boolean {
  const m = s.match;
  if (!m) {
    return false;
  }
  if (m.length === 0) {
    return m.game.phase === "finished";
  }
  return m.score.white >= m.length || m.score.black >= m.length;
}

function humanIn(s: GameStoreState, phases: Phase[]): boolean {
  const g = s.match?.game;
  const human = humanPlayer(s);
  return !!g && human !== null && !s.ui.busy && g.onRoll === human && phases.includes(g.phase);
}

export function canRoll(s: GameStoreState): boolean {
  return humanIn(s, ["toRoll"]);
}

/** Whether `player` may double now (`GameState::can_double` plus the Crawford rule). */
export function cubeAvailableTo(s: GameStoreState, player: Player): boolean {
  const m = s.match;
  if (!m || m.crawford || m.game.phase !== "toRoll" || m.game.onRoll !== player) {
    return false;
  }
  const { value, owner } = m.game.cube;
  return value < 64 && (owner === null || owner === player);
}

export function canDouble(s: GameStoreState): boolean {
  const human = humanPlayer(s);
  return human !== null && !s.ui.busy && cubeAvailableTo(s, human);
}

/** The human faces a pending double from the bot. */
function humanIsTaker(s: GameStoreState): boolean {
  const g = s.match?.game;
  const human = humanPlayer(s);
  return !!g && human !== null && !s.ui.busy && g.phase === "doubled" && g.onRoll === opponent(human);
}

export function canTake(s: GameStoreState): boolean {
  return humanIsTaker(s);
}

export function canDrop(s: GameStoreState): boolean {
  return humanIsTaker(s);
}

/** Resigning is possible while the human is on roll (the engine logs the resigner as `on_roll`). */
export function canResign(s: GameStoreState): boolean {
  return humanIn(s, ["toRoll", "toMove"]);
}

export function canUndo(s: GameStoreState): boolean {
  return !s.ui.busy && s.ui.pendingMoves.length > 0;
}

/** The legal plays consistent with the pending moves entered so far. */
export function candidatePlays(s: GameStoreState) {
  const plays = s.ui.legalPlays ?? [];
  return plays.filter((p) => movesMatchPlay(s.ui.pendingMoves, p));
}

/** A play the pending moves complete exactly, if any. */
export function completedPlay(s: GameStoreState) {
  const n = s.ui.pendingMoves.length;
  return candidatePlays(s).find((p) => p.moves.length === n) ?? null;
}

export function canConfirm(s: GameStoreState): boolean {
  return humanIn(s, ["toMove"]) && s.ui.pendingMoves.length > 0 && completedPlay(s) !== null;
}

/** The board the person is looking at: the pending moves applied, else the engine's. */
export function displayedBoard(s: GameStoreState): Board | null {
  return s.ui.pendingBoard ?? s.match?.game.board ?? null;
}

/** `true` when every one of `player`'s checkers is borne off or in the home board (none on the bar). */
export function allHome(board: Board, player: Player): boolean {
  const mine = board[player];
  if (mine[0] > 0) {
    return false;
  }
  for (let point = 1; point <= 24; point++) {
    if (mine[point] > 0 && toRelative(player, point) > HOME_TOP) {
      return false;
    }
  }
  return true;
}

/**
 * The moves of the candidate plays still to be entered that may be made
 * *next* on the displayed board. Pending moves are matched as a multiset
 * (the engine lists one canonical order per play, a person enters the moves
 * in any order), so this is where order matters: a move is offered only if
 * it is legal on the board as it stands, by the same structural rules the
 * engine's `applyPlay` enforces on a partial play — the source holds one of
 * the mover's checkers, the bar comes first, and a bear-off needs every
 * checker home (`8/6 6/off`: 6/off only after 8/6). Blocks and hits need no
 * check here: the opponent's checkers do not move during the play, so any
 * move of a legal play is open whenever it is made.
 */
function offerableMoves(s: GameStoreState): Move[] {
  const g = s.match?.game;
  const human = humanPlayer(s);
  const board = displayedBoard(s);
  if (!g || human === null || board === null || g.phase !== "toMove" || g.onRoll !== human) {
    return [];
  }
  const mine = board[human];
  const barFirst = mine[0] > 0;
  const mayBearOff = allHome(board, human);
  const moves: Move[] = [];
  for (const play of candidatePlays(s)) {
    for (const move of remainingMoves(s.ui.pendingMoves, play)) {
      if (barFirst && move.from !== 25) {
        continue;
      }
      if (move.to === 0 && !mayBearOff) {
        continue;
      }
      if (mine[toAbsolute(human, move.from)] > 0) {
        moves.push(move);
      }
    }
  }
  return moves;
}

/**
 * Sources (relative: `25` bar, else `1..24`) the human may pick up next, in
 * movement order (bar first, then 24 → 1): the `from` of every move that
 * may be made next (see `offerableMoves`) — the bar alone while a checker
 * sits there, as the rules demand.
 */
export function legalSources(s: GameStoreState): number[] {
  const sources = new Set(offerableMoves(s).map((m) => m.from));
  return [...sources].sort((a, b) => b - a);
}

/** Destinations (relative; `0` = off) reachable from `from` given the pending moves and the displayed board. */
export function legalTargetsFrom(s: GameStoreState, from: number): number[] {
  const targets = new Set(offerableMoves(s).filter((m) => m.from === from).map((m) => m.to));
  return [...targets].sort((a, b) => b - a);
}

/** The move `from → to` as it happens on `board`: a hit iff a lone opposing checker sits on `to`. */
export function moveOnBoard(board: Board, player: Player, from: number, to: number): Move {
  const hit = to !== 0 && board[opponent(player)][toAbsolute(player, to)] === 1;
  return { from, to, hit };
}
