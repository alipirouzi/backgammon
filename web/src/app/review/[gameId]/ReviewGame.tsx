"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { DEFAULT_OPTIONS, gameHref } from "@/app/play/game-options";
import { ReviewPlayer } from "@/components/review/ReviewPlayer";
import { loadReviewGame, type ReviewGameData, type ReviewLoad } from "@/components/review/game-source";
import { createEngine, type Engine } from "@/engine/client";
import type { Level, MoveAnalysis } from "@/engine/types";
import { seedFromLocalGameId } from "@/game/local-games";
import { randomSeed } from "@/game/record";
import { getGameStore, type AnalysisByTurn, type GameFormat } from "@/game/store";

import "@/components/table/table.css";
import "@/components/review/review.css";

let reviewEngine: Engine | null = null;

/**
 * The engine every review of this session uses, created on first use and
 * kept (like `getGameStore`'s): `createEngine` spawns its worker lazily, so
 * nothing runs until the first position is replayed, and a kept instance
 * survives StrictMode's mount–unmount–mount without being terminated.
 */
function getReviewEngine(): Engine {
  reviewEngine ??= createEngine();
  return reviewEngine;
}

export interface ReviewGameDeps {
  /** Replaces `loadReviewGame` (tests). */
  load?(id: string): Promise<ReviewLoad>;
  /** Replaces the worker-backed engine (tests). */
  engine?: Engine;
}

export interface ReviewGameProps {
  gameId: string;
  /** The computer's level from `?level=` (the finish banner carries it); `null` when absent. */
  level: Level | null;
  deps?: ReviewGameDeps;
}

interface Loaded {
  game: ReviewGameData;
  /** Grades the game store computed while this very game was played, when it still holds it. */
  initialAnalyses: AnalysisByTurn;
  level: Level | null;
}

type Phase = { status: "loading" } | { status: "ready"; loaded: Loaded } | Exclude<ReviewLoad, { status: "ok" }>;

/** What the game store can hand over for `gameId`: its grades and the level played, if it still holds that game. */
function handover(gameId: string): { analyses: AnalysisByTurn; level: Level | null } {
  const s = getGameStore().getState();
  return s.gameId === gameId ? { analyses: s.analysisByTurn, level: s.botLevel } : { analyses: {}, level: null };
}

/**
 * `/review/[gameId]` on the client: loads the record (this browser's storage
 * for `local-<seed>`, the games API otherwise), then hands it to
 * `ReviewPlayer`. Grades the store already computed during play seed the
 * player's cache, and grades the player computes go back to the store
 * (`rememberAnalysis`) while it still holds the same game. The level shown
 * is, in order, the URL's, the stored game's bot seat, the store's.
 */
export function ReviewGame({ gameId, level, deps = {} }: ReviewGameProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const load = deps.load;

  useEffect(() => {
    let cancelled = false;
    void (load ?? loadReviewGame)(gameId).then((result) => {
      if (cancelled) {
        return;
      }
      if (result.status !== "ok") {
        setPhase(result);
        return;
      }
      const fromStore = handover(gameId);
      setPhase({
        status: "ready",
        loaded: { game: result.game, initialAnalyses: fromStore.analyses, level: level ?? result.game.level ?? fromStore.level },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [gameId, level, load, attempt]);

  const onAnalysed = useCallback(
    (turnIndex: number, analysis: MoveAnalysis) => {
      const s = getGameStore().getState();
      if (s.gameId === gameId) {
        s.rememberAnalysis(turnIndex, analysis);
      }
    },
    [gameId],
  );

  const retry = (): void => {
    setPhase({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  switch (phase.status) {
    case "loading":
      return (
        <p className="review-notice" role="status">
          Loading the game…
        </p>
      );
    case "not-found":
      return (
        <section className="review-empty" aria-labelledby="review-empty-title">
          <h2 id="review-empty-title" className="review-empty__title">
            No such game
          </h2>
          <p className="review-empty__text">
            {phase.source === "local"
              ? "Games against the computer are kept in this browser only, and nothing is stored here under that id."
              : "Nothing is stored on the server under that id."}
          </p>
          <Link href="/play/new" className="action action--primary">
            New game
          </Link>
        </section>
      );
    case "error":
      return (
        <section className="review-empty" aria-labelledby="review-error-title">
          <h2 id="review-error-title" className="review-empty__title">
            The game could not be loaded
          </h2>
          <p className="review-empty__text" role="alert">
            {phase.message}
          </p>
          <button type="button" className="action action--primary" onClick={retry}>
            Try again
          </button>
        </section>
      );
    case "ready": {
      const { game, initialAnalyses } = phase.loaded;
      const shownLevel = phase.loaded.level;
      const format: GameFormat = game.record.length === 0 ? "single" : { matchTo: game.record.length };
      const options = { format, level: shownLevel ?? DEFAULT_OPTIONS.level };
      const seed = seedFromLocalGameId(game.id);
      const actions = (
        <>
          <button type="button" className="action action--primary" onClick={() => router.push(gameHref(randomSeed(), options))}>
            Play again
          </button>
          {game.source === "local" && seed !== null ? (
            <Link href={gameHref(seed, options)} className="action">
              Back to table
            </Link>
          ) : (
            <Link href="/play/new" className="action">
              New game
            </Link>
          )}
        </>
      );
      return (
        <ReviewPlayer
          key={game.id}
          record={game.record}
          engine={deps.engine ?? getReviewEngine()}
          human="white"
          level={shownLevel}
          initialAnalyses={initialAnalyses}
          onAnalysed={onAnalysed}
          actions={actions}
        />
      );
    }
  }
}
