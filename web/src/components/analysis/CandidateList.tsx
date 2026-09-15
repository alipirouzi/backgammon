"use client";

import { useState } from "react";

import type { Candidate } from "@/engine/types";

import { ProbBar } from "./ProbBar";
import { countText, displayedProbs, formatEquity, sampleText } from "./format";

/** Rows shown before "Show all": the head the club search refines (`keepTop`). */
export const DEFAULT_LIMIT = 5;

export interface CandidateListProps {
  /** The engine's ranking, best first. */
  candidates: Candidate[];
  /** Index of the play actually made, highlighted and always shown; `null` when nothing was played (a preview). */
  playedIndex: number | null;
  /** Table caption (visually hidden). */
  caption: string;
  /** Rows before the "Show all" control (the played row is added when it lies beyond). */
  limit?: number;
}

/**
 * Ranked candidate plays as a table: rank, notation, ranking equity, Δ to
 * the best play, the win/gammon/backgammon bar, and the sample when the row
 * was rolled out (`n=100 ±0.011`) or `1-ply` when not. The equity and Δ
 * columns are on the search scale the grade uses; the bar and the sample
 * describe the rollout estimate (see format.ts).
 */
export function CandidateList({ candidates, playedIndex, caption, limit = DEFAULT_LIMIT }: CandidateListProps) {
  const [showAll, setShowAll] = useState(false);
  const total = candidates.length;
  const truncated = total > limit;
  const best = candidates[0]?.equity ?? 0;
  const rows = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => showAll || index < limit || index === playedIndex);
  const rolledOut = candidates.some((c) => c.rollout !== null);

  return (
    <div className="cands">
      <div className="cands__scroll">
        <table className="cands__table">
          <caption className="analysis__sr">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="cands__rank">
                #
              </th>
              <th scope="col" className="cands__play">
                Play
              </th>
              <th scope="col" className="cands__num">
                Equity
              </th>
              <th scope="col" className="cands__num">
                <abbr title="Difference to the best play">Δ</abbr>
              </th>
              <th scope="col" className="cands__probs">
                Win · gammon · backgammon
              </th>
              <th scope="col" className="cands__sample">
                Sample
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ candidate, index }, position) => {
              const previous = rows[position - 1]?.index ?? -1;
              const gap = index - previous - 1;
              const { probs } = displayedProbs(candidate);
              const played = index === playedIndex;
              return [
                gap > 0 ? (
                  <tr key={`gap-${String(index)}`} className="cands__gap" aria-hidden="true">
                    <td colSpan={6}>{`… ${countText(gap, "candidate")} …`}</td>
                  </tr>
                ) : null,
                <tr key={index} data-rank={index + 1} data-played={played ? "true" : undefined}>
                  <td className="cands__rank">{index + 1}</td>
                  <td className="cands__play">
                    <span className="cands__notation">{candidate.play.notation || "no move"}</span>
                    {played ? <span className="cands__tag">played</span> : null}
                  </td>
                  <td className="cands__num">{formatEquity(candidate.equity)}</td>
                  <td className="cands__num cands__delta">{index === 0 ? "—" : formatEquity(candidate.equity - best)}</td>
                  <td className="cands__probs">
                    <ProbBar probs={probs} rollout={candidate.rollout} />
                  </td>
                  <td className="cands__sample">{candidate.rollout ? sampleText(candidate.rollout) : "1-ply"}</td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
      <p className="cands__hint">Swipe the table sideways for the win figures and the sample.</p>
      <div className="cands__foot">
        {rolledOut ? (
          <p className="cands__note">
            Win, gammon and backgammon figures are estimates from rollouts of the size shown (± one standard error); other rows are 1-ply.
          </p>
        ) : (
          <p className="cands__note">Figures are 1-ply estimates.</p>
        )}
        {truncated ? (
          <button type="button" className="action action--quiet cands__more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
            {showAll ? `Show top ${String(limit)}` : `Show all ${countText(total, "candidate")}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}
