"use client";

import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";

import { Board } from "@/components/board/Board";
import { openingBoard } from "@/components/board/types";
import type { Cube } from "@/engine/types";
import {
  canConfirm,
  canDouble,
  canDrop,
  canResign,
  canRetry,
  canRoll,
  canTake,
  canUndo,
  concededPointsFor,
  displayedBoard,
  humanPlayer,
  isAwaitingNextGame,
  isGameFinished,
  isMatchOver,
  pipCounts,
  playerToAct,
} from "@/game/selectors";
import type { GameStore } from "@/game/store";
import { opponent } from "@/game/record";

import "./table.css";
import { ActionBar } from "./ActionBar";
import { PlayerCard } from "./PlayerCard";
import { StatusLine, lastBotEvent, resultText, statusFor } from "./StatusLine";

const OPENING = openingBoard();
const CENTRED_CUBE: Cube = { value: 1, owner: null };
const MOVE_BAR = 25;
const MOVE_OFF = 0;

const LEVEL_LABEL = { beginner: "Beginner", intermediate: "Intermediate", club: "Club strength" } as const;

export interface TableLayoutProps {
  /** The game store to render and drive (`getGameStore()` in the app, a MockEngine-backed one in tests). */
  store: StoreApi<GameStore>;
  /** "Play again" on the finish banner. */
  onPlayAgain(): void;
}

/**
 * Spec §5.2: player cards flank the board (computer left, you right), the
 * action bar and status line sit under the board, the analysis drawer's
 * collapsed line is reserved below (the drawer itself is piece E). Under
 * 900px the cards become bars above and below the board.
 *
 * Two banners share the finish overlay: between the games of a match
 * (`awaitingNextGame`: last result, score, "Next game" — the store draws no
 * opening roll until then) and at the end of a money game or of the match
 * ("Play again"). After an engine failure the status line carries the error
 * and a Retry control until the stalled step succeeds.
 */
export function TableLayout({ store, onPlayAgain }: TableLayoutProps) {
  const s = useStore(store);
  const g = s.match?.game ?? null;
  const human = humanPlayer(s) ?? "white";
  const bot = opponent(human);
  const board = displayedBoard(s) ?? OPENING;
  const pips = pipCounts(board);
  const cube = g?.cube ?? CENTRED_CUBE;
  const actor = playerToAct(s);
  const score = s.match?.score ?? { white: 0, black: 0 };
  const length = s.match?.length ?? 0;
  const finished = isGameFinished(s);
  const awaiting = isAwaitingNextGame(s);
  const bannerShown = finished || awaiting;
  // Between games `match.game` is already the next game's opening roll; the result on show is `lastGameResult`.
  const result = awaiting ? s.lastGameResult : (g?.result ?? null);
  const status = statusFor(s);
  const retryable = canRetry(s);
  const ticker = lastBotEvent(s);
  const botChoice = s.analysis.forBot;
  const statusLine = useRef<HTMLParagraphElement>(null);
  const finishTitle = useRef<HTMLHeadingElement>(null);

  // The banner covers the board (which goes inert underneath); focus follows it.
  useEffect(() => {
    if (bannerShown) finishTitle.current?.focus();
  }, [bannerShown]);

  const deselect = (): void => {
    const from = store.getState().ui.selectedFrom;
    if (from !== null) void store.getState().selectPoint(from);
  };

  return (
    <div className="table" data-phase={g?.phase ?? "loading"} data-finished={finished ? "true" : undefined} data-awaiting-next-game={awaiting ? "true" : undefined}>
      <PlayerCard
        player={bot}
        name="Computer"
        caption={LEVEL_LABEL[s.botLevel]}
        score={score[bot]}
        matchLength={length}
        pips={pips[bot]}
        cube={cube}
        onRoll={actor === bot}
        side="left"
      />

      <div className="table__stage">
        <div className="table__board" inert={bannerShown}>
          <Board
            board={board}
            onRoll={g?.onRoll ?? null}
            dice={g?.dice ?? null}
            cube={cube}
            selectedFrom={s.ui.selectedFrom}
            legalTargets={s.ui.legalTargets}
            pending={s.ui.pendingMoves}
            onPointClick={(p) => void s.selectPoint(p)}
            onBarClick={() => void s.selectPoint(MOVE_BAR)}
            onOffClick={() => void s.selectPoint(MOVE_OFF)}
            onDeselect={deselect}
            perspective="white"
          />
        </div>
        {bannerShown ? (
          <section className="finish" aria-labelledby="finish-title" data-kind={awaiting ? "between-games" : "final"}>
            <p className="finish__eyebrow">{finished && isMatchOver(s) && length > 0 ? "Match over" : "Game over"}</p>
            <h2 id="finish-title" ref={finishTitle} className="finish__title" tabIndex={-1}>
              {result ? resultText(result, human) : "Game over"}
            </h2>
            {length > 0 ? (
              <p className="finish__score">
                {`Score ${String(score[human])}–${String(score[bot])} in a match to ${String(length)}`}
              </p>
            ) : null}
            <div className="finish__actions">
              {awaiting ? (
                <button type="button" className="action action--primary" disabled={s.ui.busy} onClick={() => void s.nextGame()}>
                  Next game
                </button>
              ) : (
                <button type="button" className="action action--primary" onClick={onPlayAgain}>
                  Play again
                </button>
              )}
            </div>
          </section>
        ) : null}
      </div>

      <PlayerCard
        player={human}
        name="You"
        caption={human === "white" ? "White" : "Black"}
        score={score[human]}
        matchLength={length}
        pips={pips[human]}
        cube={cube}
        onRoll={actor === human}
        side="right"
      />

      <div className="table__console">
        <StatusLine ref={statusLine} status={status} ticker={ticker} onRetry={retryable ? () => void s.retryBotTurn() : null} />
        <ActionBar
          focusFallback={statusLine}
          can={{
            roll: canRoll(s),
            undo: canUndo(s),
            confirm: canConfirm(s),
            double: canDouble(s),
            take: canTake(s),
            drop: canDrop(s),
            resign: canResign(s),
          }}
          busy={s.ui.busy}
          pointsFor={(kind) => concededPointsFor(s, kind)}
          onRoll={() => void s.roll()}
          onUndo={() => s.undoPending()}
          onConfirm={() => void s.confirmPlay()}
          onDouble={() => void s.double()}
          onTake={() => void s.take()}
          onDrop={() => void s.drop()}
          onResign={(kind) => void s.resign(kind)}
        />
      </div>

      <aside className="table__drawer" aria-label="Analysis">
        <span className="drawer__label">Analysis</span>
        <span className="drawer__verdict">
          {botChoice
            ? `Computer's choice: ${botChoice.chosen.play.notation || "no move"} · ${botChoice.chosen.candidates.length} candidate${botChoice.chosen.candidates.length === 1 ? "" : "s"}`
            : "Candidates and grades appear here as the game goes on."}
        </span>
        <button type="button" className="action action--quiet drawer__toggle" disabled title="Coming with the analysis drawer">
          Open <span className="drawer__planned">(planned)</span>
        </button>
      </aside>
    </div>
  );
}
