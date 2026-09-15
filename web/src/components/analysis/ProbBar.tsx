import type { CSSProperties } from "react";

import type { Probs, RolloutStats } from "@/engine/types";

import { formatPercent, formatStdErr } from "./format";

export interface ProbBarProps {
  /** Outcome probabilities for the side on roll (`winG ≥ winBg`, `loseG ≥ loseBg`). */
  probs: Probs;
  /** Present when the probabilities come from a rollout: named in the accessible text. */
  rollout?: RolloutStats | null;
}

type Segment = "win-bg" | "win-g" | "win" | "lose" | "lose-g" | "lose-bg";

const clamp = (p: number): number => Math.min(1, Math.max(0, p));

/**
 * One bar, six segments, left to right: backgammons won, gammons won, plain
 * wins, plain losses, gammons lost, backgammons lost — so the win side reads
 * from the left edge and the lose side from the right, and the boundary
 * between them is the win probability. Widths are percentages set through a
 * custom property (the only inline style: the values are data).
 */
export function ProbBar({ probs, rollout }: ProbBarProps) {
  const win = clamp(probs.win);
  const winG = Math.min(win, clamp(probs.winG));
  const winBg = Math.min(winG, clamp(probs.winBg));
  const lose = 1 - win;
  const loseG = Math.min(lose, clamp(probs.loseG));
  const loseBg = Math.min(loseG, clamp(probs.loseBg));

  const segments: [Segment, number][] = [
    ["win-bg", winBg],
    ["win-g", winG - winBg],
    ["win", win - winG],
    ["lose", lose - loseG],
    ["lose-g", loseG - loseBg],
    ["lose-bg", loseBg],
  ];

  const source = rollout
    ? `Rollout of ${String(rollout.trials)} games, standard error ${formatStdErr(rollout.stdErr)}.`
    : "One-ply estimate.";
  const label =
    `Win ${formatPercent(win)}% (gammon ${formatPercent(winG)}%, backgammon ${formatPercent(winBg)}%); ` +
    `lose ${formatPercent(lose)}% (gammon ${formatPercent(loseG)}%, backgammon ${formatPercent(loseBg)}%). ${source}`;

  return (
    <div className="prob" role="img" aria-label={label} data-source={rollout ? "rollout" : "1-ply"}>
      <div className="prob__track" aria-hidden="true">
        {segments.map(([kind, share]) => (
          <span key={kind} className="prob__seg" data-seg={kind} style={{ "--w": formatPercent(share) } as CSSProperties} />
        ))}
      </div>
      <p className="prob__readout" aria-hidden="true">
        <span className="prob__figure">
          {formatPercent(win)}
          <abbr title="wins">W</abbr>
        </span>
        <span className="prob__figure">
          {formatPercent(winG)}
          <abbr title="gammons">G</abbr>
        </span>
        <span className="prob__figure">
          {formatPercent(winBg)}
          <abbr title="backgammons">BG</abbr>
        </span>
      </p>
    </div>
  );
}
