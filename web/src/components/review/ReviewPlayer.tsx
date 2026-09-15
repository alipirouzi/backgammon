"use client";

import { Fragment, useEffect, useId, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";

import { CandidateList } from "@/components/analysis/CandidateList";
import { GradeBadge } from "@/components/analysis/GradeBadge";
import { diceText, formatLoss } from "@/components/analysis/format";
import { Board } from "@/components/board/Board";
import { openingBoard } from "@/components/board/types";
import type { Engine } from "@/engine/client";
import type { Cube, Level, MatchState, MoveAnalysis, Player, Record as GameRecord, Turn } from "@/engine/types";
import { matchContextFor } from "@/game/record";
import { analysisSeedFor, type AnalysisByTurn } from "@/game/store";

import "@/components/table/table.css";
import "@/components/analysis/analysis.css";
import "./review.css";
import { ReviewSummary } from "./ReviewSummary";
import {
  gradeAnnouncementFor,
  isGradableTurn,
  nextJob,
  stopCaption,
  turnRowText,
  turnVerdict,
  withoutIndex,
  type ErrorByIndex,
  type Job,
  type PositionByIndex,
} from "./model";

export interface ReviewPlayerProps {
  /** The finished game; fixed for the component's lifetime (mount a new player per game). */
  record: GameRecord;
  /** The engine that replays positions and grades plays (the worker client in the app, a MockEngine in tests). */
  engine: Engine;
  /** The seat the person played. */
  human: Player;
  /** The computer's level when known (captions only). */
  level: Level | null;
  /** Grades already computed during play (`store.analysisByTurn`); read once, on mount. */
  initialAnalyses?: AnalysisByTurn;
  /** Called once per play graded here, so the caller can remember it (`store.rememberAnalysis`). */
  onAnalysed?(turnIndex: number, analysis: MoveAnalysis): void;
  /** Rendered in the summary ("Play again", "Back to table"). */
  actions?: ReactNode;
  /** The stop to open on; `0` (the opening roll) by default. */
  initialIndex?: number;
}

const CENTRED_CUBE: Cube = { value: 1, owner: null };
/** What the stage shows at stop 0 before its replay arrives: the opening, nobody on roll, no dice, a centred cube. */
const OPENING_STOP: Pick<MatchState, "game"> = {
  game: { board: openingBoard(), onRoll: null, dice: null, cube: CENTRED_CUBE, phase: "openingRoll", result: null, rules: { jacoby: false, beavers: false, autoDoubles: false } },
};
const NO_ERRORS: ErrorByIndex = Object.freeze({});
const NO_POSITIONS: PositionByIndex = Object.freeze({});
const NO_ANALYSES: AnalysisByTurn = Object.freeze({});
const noop = (): void => undefined;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Keys the window listener leaves alone: something else owns arrows there. */
const OWN_KEYS_SELECTOR = "input, select, textarea, [contenteditable=true], [role=tablist], [role=radiogroup], [role=listbox], [role=menu], [role=slider]";

/**
 * Steps through a finished game: the board before every turn, a transport
 * (first / previous / next / last, a slider, ← → Home End anywhere on the
 * page), the move list, and for every play the engine's club-strength
 * analysis — the same `analyzePlay` call, with the same seed
 * (`analysisSeedFor`), that graded the play during the game, so the rollouts
 * shown here are the ones the person saw at the table.
 *
 * Positions come from `replay` of the record's prefixes and analyses from
 * `analyzePlay`; both are cached per stop. One engine job is outstanding at
 * a time (`nextJob`): what the current stop needs first, then the final
 * position for the summary, then every other play in record order, so the
 * summary's counts complete by themselves. A failed job is shown at its
 * stop with a Retry control and is not retried on its own. Until the
 * position of the stop on show is cached the stage is a placeholder that
 * says so (stop 0 excepted: the position before the opening roll is the
 * opening), never some other stop's position under this stop's caption.
 *
 * A transport button that disables itself under focus (Next at the last
 * stop, Previous at the first) would drop keyboard focus to <body>; focus
 * parks on the caption instead, as the table's ActionBar parks it on the
 * status line.
 */
export function ReviewPlayer({ record, engine, human, level, initialAnalyses, onAnalysed, actions, initialIndex = 0 }: ReviewPlayerProps) {
  const last = record.turns.length;
  const clamp = (i: number): number => Math.max(0, Math.min(last, i));

  const [index, setIndex] = useState(() => clamp(initialIndex));
  const [positions, setPositions] = useState<PositionByIndex>(NO_POSITIONS);
  const [positionErrors, setPositionErrors] = useState<ErrorByIndex>(NO_ERRORS);
  const [analyses, setAnalyses] = useState<AnalysisByTurn>(() => initialAnalyses ?? NO_ANALYSES);
  const [analysisErrors, setAnalysisErrors] = useState<ErrorByIndex>(NO_ERRORS);
  /** An engine job is outstanding; the scheduler waits for it (refs: the effect must see the live value). */
  const busy = useRef(false);
  const alive = useRef(true);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const caption = useRef<HTMLParagraphElement>(null);
  /** The last activated transport button, until it either disables (focus is parked) or focus moves on. */
  const activated = useRef<HTMLButtonElement | null>(null);
  const baseId = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Scheduler: whenever the caches or the stop change and nothing is in flight, run the next job.
  useEffect(() => {
    if (busy.current) {
      return;
    }
    const job = nextJob(record, index, { positions, positionErrors, analyses, analysisErrors });
    if (job === null) {
      return;
    }
    busy.current = true;
    const run = async (j: Job): Promise<() => void> => {
      if (j.kind === "position") {
        try {
          const state = await engine.replay({ ...record, turns: record.turns.slice(0, j.index) });
          return () => setPositions((prev) => (j.index in prev ? prev : { ...prev, [j.index]: state }));
        } catch (error) {
          const message = errorMessage(error);
          return () => setPositionErrors((prev) => ({ ...prev, [j.index]: message }));
        }
      }
      const before = positions[j.index];
      const turn = record.turns[j.index];
      try {
        const analysis = await engine.analyzePlay(
          before.game.board,
          turn.player,
          turn.dice!,
          matchContextFor(before, turn.player),
          turn.play!,
          analysisSeedFor(record, j.index),
        );
        return () => {
          setAnalyses((prev) => (j.index in prev ? prev : { ...prev, [j.index]: analysis }));
          onAnalysed?.(j.index, analysis);
        };
      } catch (error) {
        const message = errorMessage(error);
        return () => setAnalysisErrors((prev) => ({ ...prev, [j.index]: message }));
      }
    };
    void run(job).then((apply) => {
      busy.current = false;
      if (alive.current) {
        apply();
      }
    });
  }, [record, engine, index, positions, positionErrors, analyses, analysisErrors, onAnalysed]);

  // ← → Home End anywhere on the page, unless a control that owns its arrow keys has focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OWN_KEYS_SELECTOR)) {
        return;
      }
      const step = (delta: number): void => setIndex((i) => Math.max(0, Math.min(last, i + delta)));
      switch (event.key) {
        case "ArrowLeft":
          step(-1);
          break;
        case "ArrowRight":
          step(1);
          break;
        case "Home":
          setIndex(0);
          break;
        case "End":
          setIndex(last);
          break;
        default:
          return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [last]);

  // Keep the current row of the move list in view.
  useEffect(() => {
    const row = rowRefs.current[index];
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [index]);

  // A `disabled` control drops keyboard focus to <body>; park it on the caption instead.
  useEffect(() => {
    const control = activated.current;
    if (!control) return;
    const active = document.activeElement;
    if (active !== control && active !== document.body && active !== null) {
      activated.current = null;
      return;
    }
    if (control.disabled) {
      activated.current = null;
      caption.current?.focus();
    }
  });

  /** Capture-phase click on the transport buttons: remember which one was activated. */
  const remember = (event: MouseEvent<HTMLDivElement>): void => {
    activated.current = event.target instanceof Element ? event.target.closest("button") : null;
  };

  const go = (i: number): void => setIndex(clamp(i));
  const turn: Turn | null = index < last ? record.turns[index] : null;
  const before = positions[index] ?? null;
  const analysis = turn && isGradableTurn(turn) ? (analyses[index] ?? null) : null;
  const captionText = stopCaption(record, index, human, before);
  const captionId = `${baseId}-caption`;
  const played = analysis?.candidates[analysis.playedIndex]?.play.moves ?? [];
  /** Stop 0 is the position before the opening roll, known without a replay; any other stop waits for its own. */
  const shown = before ?? (index === 0 ? OPENING_STOP : null);

  return (
    <div className="review-player" data-testid="review-player" data-stop={index}>
      <ReviewSummary record={record} analyses={analyses} human={human} level={level} final={positions[last] ?? null} actions={actions} />

      <div className="review-player__grid">
        <section className="review-stage" aria-label="Position">
          {shown === null ? (
            <p className="review-stage__placeholder" role="status" aria-busy="true" data-testid="stage-placeholder">
              Replaying the position…
            </p>
          ) : (
            <div className="review-stage__board" inert aria-busy={before === null}>
              <Board
                board={shown.game.board}
                onRoll={turn?.player ?? shown.game.onRoll}
                dice={turn?.dice ?? shown.game.dice}
                cube={shown.game.cube}
                selectedFrom={null}
                legalTargets={[]}
                pending={played}
                onPointClick={noop}
                onBarClick={noop}
                onOffClick={noop}
                perspective="white"
              />
            </div>
          )}
          {positionErrors[index] ? (
            <p className="review-stage__error" role="alert">
              {`This position could not be replayed: ${positionErrors[index]}`}
              <button type="button" className="action action--quiet" onClick={() => setPositionErrors((prev) => withoutIndex(prev, index))}>
                Retry
              </button>
            </p>
          ) : null}

          <div className="transport" role="group" aria-label="Turns">
            <div className="transport__buttons" onClickCapture={remember}>
              <button type="button" className="action transport__button" aria-label="First turn" disabled={index === 0} onClick={() => go(0)}>
                <span aria-hidden="true">⏮</span>
              </button>
              <button type="button" className="action transport__button" aria-label="Previous turn" disabled={index === 0} onClick={() => go(index - 1)}>
                <span aria-hidden="true">◀</span>
              </button>
              <button type="button" className="action transport__button" aria-label="Next turn" disabled={index === last} onClick={() => go(index + 1)}>
                <span aria-hidden="true">▶</span>
              </button>
              <button type="button" className="action transport__button" aria-label="Last turn" disabled={index === last} onClick={() => go(last)}>
                <span aria-hidden="true">⏭</span>
              </button>
            </div>
            <input
              type="range"
              className="transport__slider"
              aria-label="Turn"
              aria-describedby={captionId}
              aria-valuetext={captionText}
              min={0}
              max={last}
              step={1}
              value={index}
              onChange={(event) => go(Number(event.target.value))}
            />
            <p id={captionId} ref={caption} className="transport__caption" data-testid="stop-caption" tabIndex={-1}>
              <span className="transport__count">{index < last ? `Turn ${String(index + 1)} of ${String(last)}` : "End"}</span>
              <span className="transport__text">{captionText}</span>
            </p>
            <p className="transport__hint">Use ← and → to step, Home and End to jump.</p>
          </div>
        </section>

        <aside className="review-turns" aria-label="Move list">
          <ol className="turns" aria-label="Moves">
            {record.turns.map((t, i) => (
              <li key={i}>
                <TurnRow
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  turn={t}
                  index={i}
                  human={human}
                  current={i === index}
                  analysis={analyses[i] ?? null}
                  failed={i in analysisErrors}
                  onSelect={() => go(i)}
                />
              </li>
            ))}
            <li key="end">
              <button
                ref={(el) => {
                  rowRefs.current[last] = el;
                }}
                type="button"
                className="turn turn--end"
                aria-current={index === last ? "step" : undefined}
                onClick={() => go(last)}
              >
                <span className="turn__index" aria-hidden="true">
                  ·
                </span>
                <span className="turn__text">Final position</span>
              </button>
            </li>
          </ol>
        </aside>

        <section className="review-analysis" aria-label="Analysis of this turn" aria-busy={turn !== null && isGradableTurn(turn) && analysis === null && !(index in analysisErrors)}>
          <TurnAnalysis
            turn={turn}
            human={human}
            analysis={analysis}
            error={analysisErrors[index] ?? null}
            final={index === last ? (positions[last] ?? null) : null}
            onRetry={() => setAnalysisErrors((prev) => withoutIndex(prev, index))}
          />
        </section>
      </div>

      <p className="review__sr" aria-live="polite" aria-atomic="true" data-testid="grade-announcement">
        {turn && analysis ? gradeAnnouncementFor(turn, analysis, human) : ""}
      </p>
    </div>
  );
}

interface TurnRowProps {
  ref: (el: HTMLButtonElement | null) => void;
  turn: Turn;
  index: number;
  human: Player;
  current: boolean;
  analysis: MoveAnalysis | null;
  failed: boolean;
  onSelect(): void;
}

function TurnRow({ ref, turn, index, human, current, analysis, failed, onSelect }: TurnRowProps) {
  const gradable = isGradableTurn(turn);
  // One nowrap span per move, so a long play wraps between moves ("13/10(2) 10/7*" / "10/7"), never inside one ("18/" / "15").
  const tokens = turnRowText(turn, index).split(" ");
  return (
    <button
      ref={ref}
      type="button"
      className="turn"
      aria-current={current ? "step" : undefined}
      data-player={turn.player}
      data-action={turn.action}
      onClick={onSelect}
    >
      <span className="turn__index">{index + 1}</span>
      <span className="turn__who">{turn.player === human ? "You" : "Computer"}</span>
      <span className="turn__dice">{turn.action === "move" && turn.dice ? diceText(turn.dice) : ""}</span>
      <span className="turn__text">
        {tokens.map((token, i) => (
          <Fragment key={i}>
            {i > 0 ? " " : null}
            <span className="turn__token">{token}</span>
          </Fragment>
        ))}
      </span>
      <span className="turn__grade">
        {analysis ? (
          <GradeBadge category={analysis.category} errorSize={analysis.errorSize} />
        ) : gradable ? (
          <span className="turn__pending" aria-label={failed ? "analysis failed" : "not yet graded"}>
            {failed ? "!" : "…"}
          </span>
        ) : null}
      </span>
    </button>
  );
}

interface TurnAnalysisProps {
  turn: Turn | null;
  human: Player;
  analysis: MoveAnalysis | null;
  error: string | null;
  /** The final position when the last stop is on show. */
  final: MatchState | null;
  onRetry(): void;
}

/** The analysis panel for one stop: the grade and candidate table for a play, a note for anything else. */
function TurnAnalysis({ turn, human, analysis, error, final, onRetry }: TurnAnalysisProps) {
  if (turn === null) {
    const result = final?.game.result;
    return <p className="review-analysis__note">{result ? `The game ended here${result.kind === "single" ? "" : ` with a ${result.kind}`}.` : "The end of the record."}</p>;
  }
  if (!isGradableTurn(turn)) {
    const cube = turn.action === "double" || turn.action === "take" || turn.action === "drop";
    return <p className="review-analysis__note">{cube ? "Cube decisions are not graded (planned)." : "Nothing to grade on this turn."}</p>;
  }
  if (error !== null) {
    return (
      <p className="review-analysis__error">
        <span>{`Analysis unavailable: ${error}`}</span>
        <button type="button" className="action action--quiet" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }
  const you = turn.player === human;
  const dice = turn.dice ? diceText(turn.dice) : "";
  if (analysis === null) {
    return <p className="review-analysis__note">{`Analysing ${you ? "your" : "the computer's"} ${turn.play ?? ""} with ${dice}…`}</p>;
  }
  const best = analysis.candidates[0]?.play.notation;
  const meta = [
    `with ${dice}`,
    analysis.category === "best" ? "the best play" : `lost ${formatLoss(analysis.errorSize)} to ${best ?? "the best play"}`,
    "club analysis: 2-ply + rollouts",
  ];
  return (
    <div className="decision" data-side={you ? "you" : "computer"}>
      <header className="decision__head">
        <h3 className="decision__title">
          <GradeBadge category={analysis.category} errorSize={analysis.errorSize} />
          <span>{`${you ? "You" : "The computer"} played ${turn.play ?? ""}`}</span>
        </h3>
        <p className="decision__meta">{meta.join(" · ")}</p>
        <p className="review__sr">{turnVerdict(turn, analysis, human)}</p>
      </header>
      <CandidateList candidates={analysis.candidates} playedIndex={analysis.playedIndex} caption={`Candidates for ${you ? "your" : "the computer's"} ${dice}`} />
    </div>
  );
}
