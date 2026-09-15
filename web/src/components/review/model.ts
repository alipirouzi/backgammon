/**
 * Pure helpers of the post-game review: which turns can be graded, the text
 * of every stop, the per-side summary, and the scheduler's choice of the
 * next engine job. The player steps through `stops = turns.length + 1`
 * positions: stop `i < turns.length` is the position *before* turn `i`
 * (`replay` of the first `i` turns), the last stop is the final position.
 */

import { GRADE_LABEL, diceText, formatLoss } from "@/components/analysis/format";
import type { Category, Level, MatchState, MoveAnalysis, Player, Record as GameRecord, Turn } from "@/engine/types";
import type { AnalysisByTurn } from "@/game/store";

export type PositionByIndex = Readonly<{ [index: number]: MatchState }>;
export type ErrorByIndex = Readonly<{ [index: number]: string }>;

export const LEVEL_NAME: { readonly [L in Level]: string } = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  club: "Club strength",
};

/** A move turn that made a play: the only turns `analyzePlay` can grade (a forfeited turn has `play === ""`). */
export function isGradableTurn(turn: Turn): boolean {
  return turn.action === "move" && turn.dice !== null && typeof turn.play === "string" && turn.play !== "";
}

/** Indices of the gradable turns of `record`, in order. */
export function gradableTurns(record: GameRecord): number[] {
  const indices: number[] = [];
  record.turns.forEach((turn, index) => {
    if (isGradableTurn(turn)) {
      indices.push(index);
    }
  });
  return indices;
}

const pointsText = (points: number): string => `${String(points)} point${points === 1 ? "" : "s"}`;

/** Subject and verb forms for a side: the person is addressed as "You", the bot is "The computer". */
function subject(player: Player, human: Player): { name: string; s: string; possessive: string } {
  return player === human ? { name: "You", s: "", possessive: "your" } : { name: "The computer", s: "s", possessive: "the computer's" };
}

/**
 * One sentence for stop `index`: what turn `index` did (or "Final position").
 * `before`, when known, tells an opening roll from a regular one after the
 * first game of a match and gives the cube's new value on a double.
 */
export function stopCaption(record: GameRecord, index: number, human: Player, before: MatchState | null = null): string {
  const turn = record.turns[index];
  if (turn === undefined) {
    return "Final position";
  }
  const who = subject(turn.player, human);
  const dice = turn.dice ? diceText(turn.dice) : "";
  switch (turn.action) {
    case "roll": {
      const opening = index === 0 || before?.game.phase === "openingRoll";
      return opening ? `${who.name} win${who.s} the opening roll ${dice}` : `${who.name} roll${who.s} ${dice}`;
    }
    case "move":
      if (!turn.play) {
        return `${who.name} ${turn.player === human ? "have" : "has"} no legal move with ${dice}`;
      }
      return `${who.name} play${who.s} ${turn.play} with ${dice}`;
    case "double":
      return before ? `${who.name} double${who.s} to ${String(before.game.cube.value * 2)}` : `${who.name} double${who.s}`;
    case "take":
      return `${who.name} take${who.s}`;
    case "drop":
      return `${who.name} drop${who.s}`;
    case "resign":
      return `${who.name} resign${who.s} (${pointsText(turn.resignPoints ?? 0)})`;
  }
}

/** The short form for a row of the move list: the dice are in their own column. */
export function turnRowText(turn: Turn, index: number): string {
  switch (turn.action) {
    case "roll":
      return index === 0 ? "opening roll" : "rolls";
    case "move":
      return turn.play ? turn.play : "no legal move";
    case "double":
      return "doubles";
    case "take":
      return "takes";
    case "drop":
      return "drops";
    case "resign":
      return `resigns (${pointsText(turn.resignPoints ?? 0)})`;
  }
}

/** `your 24/23 23/18 lost 0.035` · `the computer's 13/10 was the best play`. */
export function turnVerdict(turn: Turn, analysis: MoveAnalysis, human: Player): string {
  const who = subject(turn.player, human);
  const play = `${who.possessive} ${turn.play ?? ""}`;
  return analysis.category === "best" ? `${play} was the best play` : `${play} lost ${formatLoss(analysis.errorSize)}`;
}

/** What the live region says for a graded stop: `Error: your 24/23 23/18 lost 0.035`. */
export function gradeAnnouncementFor(turn: Turn, analysis: MoveAnalysis, human: Player): string {
  return `${GRADE_LABEL[analysis.category]}: ${turnVerdict(turn, analysis, human)}`;
}

// ---------------------------------------------------------------------------
// Summary

export interface SideSummary {
  /** Gradable plays made by this side. */
  plays: number;
  /** … of which graded so far. */
  graded: number;
  errors: number;
  blunders: number;
  /** Total equity lost over the graded plays. */
  lost: number;
}

export interface Summary {
  white: SideSummary;
  black: SideSummary;
  plays: number;
  graded: number;
}

const EMPTY_SIDE: SideSummary = { plays: 0, graded: 0, errors: 0, blunders: 0, lost: 0 };

const COUNTED: { readonly [K in Category]?: keyof Pick<SideSummary, "errors" | "blunders"> } = { error: "errors", blunder: "blunders" };

/** Errors, blunders and equity lost per side over the gradable plays of `record`, as far as `analyses` covers them. */
export function summarize(record: GameRecord, analyses: AnalysisByTurn): Summary {
  const sides: { white: SideSummary; black: SideSummary } = { white: { ...EMPTY_SIDE }, black: { ...EMPTY_SIDE } };
  record.turns.forEach((turn, index) => {
    if (!isGradableTurn(turn)) {
      return;
    }
    const side = sides[turn.player];
    side.plays += 1;
    const analysis = analyses[index];
    if (analysis === undefined) {
      return;
    }
    side.graded += 1;
    side.lost += Math.max(0, analysis.errorSize);
    const counted = COUNTED[analysis.category];
    if (counted) {
      side[counted] += 1;
    }
  });
  return {
    ...sides,
    plays: sides.white.plays + sides.black.plays,
    graded: sides.white.graded + sides.black.graded,
  };
}

// ---------------------------------------------------------------------------
// Scheduler

export type Job = { kind: "position"; index: number } | { kind: "analysis"; index: number };

export interface Caches {
  positions: PositionByIndex;
  positionErrors: ErrorByIndex;
  analyses: AnalysisByTurn;
  analysisErrors: ErrorByIndex;
}

/**
 * The next engine call worth making, one at a time (the worker queue is
 * strictly sequential, so only ever one job is outstanding): the position
 * on show, the final position (the summary's result), the neighbouring
 * positions (replays are cheap, so a step to either side never waits behind
 * a rollout), the grade of the play on show, then — in record order — every
 * other gradable play, so the summary fills in by itself. An index that
 * failed is left alone until `Retry` clears its error; `null` when nothing
 * is left.
 */
export function nextJob(record: GameRecord, index: number, caches: Caches): Job | null {
  const last = record.turns.length;
  const positionMissing = (i: number): boolean => !(i in caches.positions) && !(i in caches.positionErrors);
  const analysisMissing = (i: number): boolean => !(i in caches.analyses) && !(i in caches.analysisErrors);
  const analysisDue = (i: number): boolean => isGradableTurn(record.turns[i]) && analysisMissing(i);

  if (positionMissing(index)) {
    return { kind: "position", index };
  }
  if (positionMissing(last)) {
    return { kind: "position", index: last };
  }
  for (const near of [index + 1, index - 1]) {
    if (near >= 0 && near <= last && positionMissing(near)) {
      return { kind: "position", index: near };
    }
  }
  if (index < last && analysisDue(index) && index in caches.positions) {
    return { kind: "analysis", index };
  }
  for (const i of gradableTurns(record)) {
    if (!analysisDue(i)) {
      continue;
    }
    if (positionMissing(i)) {
      return { kind: "position", index: i };
    }
    if (i in caches.positions) {
      return { kind: "analysis", index: i };
    }
  }
  return null;
}

/** `errors` without the entry for `index` (a new object; the input is untouched). */
export function withoutIndex(errors: ErrorByIndex, index: number): ErrorByIndex {
  return Object.fromEntries(Object.entries(errors).filter(([key]) => Number(key) !== index));
}
