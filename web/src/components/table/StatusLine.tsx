"use client";

import type { Ref } from "react";

import type { Dice, GameResult, Player, Turn } from "@/engine/types";
import { canConfirm, canDouble, humanPlayer, isAwaitingNextGame, isBotTurn } from "@/game/selectors";
import type { GameStoreState } from "@/game/store";

export type StatusTone = "info" | "busy" | "error" | "result";

export interface Status {
  text: string;
  tone: StatusTone;
}

const diceText = (dice: Dice): string => `${String(dice.hi)}-${String(dice.lo)}`;

const pointsText = (n: number): string => `${String(n)} point${n === 1 ? "" : "s"}`;

/** "You win 2 points (gammon)" / "The computer wins 1 point", from the person's side. */
export function resultText(result: GameResult, human: Player): string {
  const who = result.winner === human ? "You win" : "The computer wins";
  const kind = result.kind === "single" ? "" : ` (${result.kind})`;
  return `${who} ${pointsText(result.points)}${kind}`;
}

/** The one line that tells the person what is happening and what to do next. */
export function statusFor(s: GameStoreState): Status {
  if (s.ui.lastError !== null) {
    return { text: s.ui.lastError, tone: "error" };
  }
  const m = s.match;
  if (!m) {
    return { text: "Setting up the table…", tone: "busy" };
  }
  const g = m.game;
  const human = humanPlayer(s) ?? "white";
  if (g.phase === "finished") {
    return { text: g.result ? resultText(g.result, human) : "Game over", tone: "result" };
  }
  if (isAwaitingNextGame(s)) {
    // A game of the match is over and on show; the next opening roll waits for "Next game".
    return { text: s.lastGameResult ? resultText(s.lastGameResult, human) : "Game over", tone: "result" };
  }
  if (g.phase === "doubled" && g.onRoll === human) {
    // The person doubled; the computer is deciding — say so rather than the generic "thinking".
    return { text: `You doubled to ${String(g.cube.value * 2)} — waiting for the computer`, tone: "busy" };
  }
  if (s.ui.busy || isBotTurn(s)) {
    return { text: "Computer is thinking…", tone: "busy" };
  }
  switch (g.phase) {
    case "openingRoll":
      return { text: "Rolling for the opening…", tone: "busy" };
    case "doubled":
      return { text: `The computer doubles to ${String(g.cube.value * 2)}. Take or drop?`, tone: "info" };
    case "toRoll":
      return { text: canDouble(s) ? "Your turn — roll, or double" : "Your turn — roll", tone: "info" };
    case "toMove": {
      const roll = g.dice ? `Your roll: ${diceText(g.dice)}` : "Your move";
      if (canConfirm(s)) {
        return { text: `${roll} — confirm your play`, tone: "info" };
      }
      if (s.ui.selectedFrom !== null) {
        return { text: `${roll} — choose a destination`, tone: "info" };
      }
      if (s.ui.pendingMoves.length > 0) {
        return { text: `${roll} — keep moving, or undo`, tone: "info" };
      }
      return { text: `${roll} — pick a checker`, tone: "info" };
    }
  }
}

function botEventText(turn: Turn): string | null {
  switch (turn.action) {
    case "move":
      if (!turn.dice) {
        return null;
      }
      return turn.play === "" || turn.play === null
        ? `Computer could not move with ${diceText(turn.dice)}`
        : `Computer played ${turn.play} with ${diceText(turn.dice)}`;
    case "double":
      return "Computer doubles";
    case "take":
      return "Computer takes";
    case "drop":
      return "Computer drops";
    case "resign":
      return "Computer resigns";
    case "roll":
      return null;
  }
}

/**
 * The computer's most recent logged action, read back from the record, until
 * the person has acted again (their own rolls do not hide it). `null` when
 * there is nothing to report.
 */
export function lastBotEvent(s: GameStoreState): string | null {
  const turns = s.record?.turns;
  if (!turns) {
    return null;
  }
  const human = humanPlayer(s) ?? "white";
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.player === human) {
      if (turn.action === "roll") {
        continue;
      }
      return null;
    }
    const text = botEventText(turn);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

export interface StatusLineProps {
  status: Status;
  /** Secondary line: what the computer just did. */
  ticker?: string | null;
  /** The status paragraph, focusable (`tabIndex -1`) so the action bar can park focus on it. */
  ref?: Ref<HTMLParagraphElement>;
  /** Offered after an engine failure (`canRetry`): runs the stalled step again. The error stays until it succeeds. */
  onRetry?: (() => void) | null;
}

/**
 * Two polite live regions: the status line, and the ticker for the computer's
 * move (its own region, always mounted, so the move is announced once rather
 * than re-read with every status change).
 */
export function StatusLine({ status, ticker, ref, onRetry }: StatusLineProps) {
  return (
    <div className="status">
      <p ref={ref} className="status__line" role="status" aria-live="polite" data-tone={status.tone} tabIndex={-1}>
        {status.tone === "busy" ? <span className="status__pulse" aria-hidden="true" /> : null}
        <span className="status__text">{status.text}</span>
      </p>
      {onRetry ? (
        <button type="button" className="action action--primary status__retry" onClick={onRetry}>
          Retry
        </button>
      ) : null}
      <p className="status__ticker" aria-live="polite" aria-atomic="true">
        {ticker ?? ""}
      </p>
    </div>
  );
}
