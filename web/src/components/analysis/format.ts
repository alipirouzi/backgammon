/**
 * Text for the analysis drawer: equities, losses, percentages, verdict lines
 * and grade labels. Every number is rendered with `toFixed`, so digits are
 * Latin whatever the locale (plan: Latin digits everywhere in game UI).
 *
 * Two equity scales meet here and must not be mixed: `Candidate.equity` is
 * the search equity the play was *ranked by* (and the scale `errorSize` and
 * the grade come from), `Candidate.rollout.equity` is the rollout estimate.
 * The equity column and the Δ against the best play use the former; the
 * rollout only feeds the labelled estimate (probabilities, `n`, `±`).
 */

import type { Candidate, Category, Dice, Level, Probs, RolloutStats } from "@/engine/types";
import type { BotAnalysis, HumanAnalysis } from "@/game/store";

const EQUITY_DECIMALS = 3;
const PERCENT_DECIMALS = 1;

export const GRADE_LABEL: { readonly [K in Category]: string } = {
  best: "Best",
  fine: "Fine",
  error: "Error",
  blunder: "Blunder",
};

/** How the computer chose at each level (spec §4.5), for the drawer's captions. */
export const LEVEL_SEARCH: { readonly [L in Level]: string } = {
  beginner: "Beginner · 1-ply with noise",
  intermediate: "Intermediate · 1-ply",
  club: "Club · 2-ply + rollouts",
};

/** `+0.021`, `-0.359`, `+0.000`. */
export function formatEquity(equity: number): string {
  const fixed = Math.abs(equity).toFixed(EQUITY_DECIMALS);
  return `${equity < 0 && fixed !== (0).toFixed(EQUITY_DECIMALS) ? "-" : "+"}${fixed}`;
}

/** An equity lost, unsigned: `0.035`. */
export function formatLoss(loss: number): string {
  return Math.max(0, loss).toFixed(EQUITY_DECIMALS);
}

/** `±0.011`. */
export function formatStdErr(stdErr: number): string {
  return `±${stdErr.toFixed(EQUITY_DECIMALS)}`;
}

/** A probability as a percentage with one decimal: `62.3`. */
export function formatPercent(p: number): string {
  return (Math.min(1, Math.max(0, p)) * 100).toFixed(PERCENT_DECIMALS);
}

export function diceText(dice: Dice): string {
  return `${String(dice.hi)}-${String(dice.lo)}`;
}

export function countText(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

/** The sample line shown when a candidate was rolled out: `n=100 ±0.011`. */
export function sampleText(rollout: RolloutStats): string {
  return `n=${String(rollout.trials)} ${formatStdErr(rollout.stdErr)}`;
}

/** The probabilities to draw for a candidate: the rollout's when it has one, else the 1-ply evaluation's. */
export function displayedProbs(candidate: Candidate): { probs: Probs; source: "rollout" | "1-ply" } {
  return candidate.rollout ? { probs: candidate.rollout.probs, source: "rollout" } : { probs: candidate.probs, source: "1-ply" };
}

/** Collapsed verdict for the computer's move: `Computer played 13/8 6/5 · +0.021 · 74 candidates`. */
export function botVerdict(forBot: BotAnalysis): string {
  const { play, candidates } = forBot.chosen;
  if (play.notation === "") {
    return `Computer had no legal move with ${diceText(forBot.dice)}`;
  }
  const equity = candidates[0]?.equity;
  const parts = [`Computer played ${play.notation}`];
  if (equity !== undefined) {
    parts.push(formatEquity(equity));
  }
  parts.push(countText(candidates.length, "candidate"));
  return parts.join(" · ");
}

/** Collapsed verdict for the person's move: `your 24/18 13/10 lost 0.035` (`… was the best play` for a best). */
export function humanVerdict(forHuman: HumanAnalysis): string {
  const { played, analysis, error } = forHuman;
  const yours = `your ${played || "pass"}`;
  if (analysis === null) {
    return `${yours} — analysis unavailable${error ? ` (${error})` : ""}`;
  }
  if (analysis.category === "best") {
    return `${yours} was the best play`;
  }
  return `${yours} lost ${formatLoss(analysis.errorSize)}`;
}

/** What the live region says when a grade arrives: `Fine: your 13/8 6/5 lost 0.017`. */
export function gradeAnnouncement(forHuman: HumanAnalysis): string {
  const verdict = humanVerdict(forHuman);
  return forHuman.analysis ? `${GRADE_LABEL[forHuman.analysis.category]}: ${verdict}` : verdict;
}
