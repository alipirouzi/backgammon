import type { CSSProperties, ReactNode } from "react";

import { formatLoss } from "@/components/analysis/format";
import { resultText } from "@/components/table/StatusLine";
import type { Level, MatchState, Player, Record as GameRecord } from "@/engine/types";
import { opponent } from "@/game/record";
import type { AnalysisByTurn } from "@/game/store";

import { LEVEL_NAME, summarize, type SideSummary } from "./model";

export { summarize } from "./model";

export interface ReviewSummaryProps {
  record: GameRecord;
  /** Club-strength grades by turn index, as far as they have been computed. */
  analyses: AnalysisByTurn;
  /** The seat the person played; the other side is the computer. */
  human: Player;
  /** The computer's level when known (captions only). */
  level: Level | null;
  /** The final position (`replay` of the whole record), `null` while it loads. */
  final: MatchState | null;
  /** Buttons and links rendered under the figures ("Play again", "Back to table"). */
  actions?: ReactNode;
}

const NO_FIGURE = "—";

/**
 * The review's header, in the manner of a broadcast scoreboard: the result
 * in display type, then one card per side with the errors, the blunders and
 * the equity lost over that side's graded plays, and the grading progress
 * (the player grades every play in the background, so the counts grow until
 * "n of n plays graded").
 */
export function ReviewSummary({ record, analyses, human, level, final, actions }: ReviewSummaryProps) {
  const bot = opponent(human);
  const summary = summarize(record, analyses);
  const length = record.length;
  const result = final?.game.result ?? null;
  const complete = summary.graded === summary.plays;
  const eyebrow = [length === 0 ? "Single game" : `Match to ${String(length)}`, level ? LEVEL_NAME[level] : "Against the computer"].join(" · ");

  return (
    <header className="review-summary" data-complete={complete ? "true" : undefined}>
      <div className="review-summary__result">
        <p className="review-summary__eyebrow">{eyebrow}</p>
        <h2 className="review-summary__title">
          {result ? resultText(result, human) : final ? (final.game.phase === "finished" ? "Game over" : "Game in progress") : "Replaying the game…"}
        </h2>
        {final && length > 0 ? (
          <p className="review-summary__score">{`Score ${String(final.score[human])}–${String(final.score[bot])} in a match to ${String(length)}`}</p>
        ) : null}
      </div>
      <div className="review-summary__sides">
        <SideCard name="You" side={summary[human]} player={human} />
        <SideCard name="Computer" side={summary[bot]} player={bot} />
      </div>
      <div className="review-summary__foot">
        <p className="review-summary__progress">
          <span className="review-summary__bar" aria-hidden="true">
            {/* The only inline style: the fill's share is data (a custom property, animated on transform). */}
            <span className="review-summary__bar-fill" style={{ "--progress": String(summary.plays === 0 ? 1 : summary.graded / summary.plays) } as CSSProperties} />
          </span>
          <span>{`${String(summary.graded)} of ${String(summary.plays)} ${summary.plays === 1 ? "play" : "plays"} graded · club analysis: 2-ply + rollouts, seeded as in play`}</span>
        </p>
        {actions ? <div className="review-summary__actions">{actions}</div> : null}
      </div>
    </header>
  );
}

function SideCard({ name, side, player }: { name: string; side: SideSummary; player: Player }) {
  const graded = side.graded > 0;
  return (
    <div className="side-card" role="group" aria-label={name} data-player={player}>
      <h3 className="side-card__name">
        <span className="side-card__checker" aria-hidden="true" />
        {name}
      </h3>
      <dl className="side-card__figures">
        <div className="side-card__figure" data-kind="errors">
          <dt>Errors</dt>
          <dd>{graded ? String(side.errors) : NO_FIGURE}</dd>
        </div>
        <div className="side-card__figure" data-kind="blunders">
          <dt>Blunders</dt>
          <dd>{graded ? String(side.blunders) : NO_FIGURE}</dd>
        </div>
        <div className="side-card__figure" data-kind="lost">
          <dt>Equity lost</dt>
          <dd>{graded ? formatLoss(side.lost) : NO_FIGURE}</dd>
        </div>
      </dl>
      <p className="side-card__plays">{`${String(side.graded)} of ${String(side.plays)} ${side.plays === 1 ? "play" : "plays"} graded`}</p>
    </div>
  );
}
