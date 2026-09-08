"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";

import { TableLayout } from "@/components/table/TableLayout";
import type { Level } from "@/engine/types";
import { randomSeed } from "@/game/record";
import { automaticActionDue, canRetry } from "@/game/selectors";
import { getGameStore, type GameFormat } from "@/game/store";

import { gameHref } from "../game-options";

export interface PlayGameProps {
  gameId: string;
  seed: number;
  format: GameFormat;
  level: Level;
}

/**
 * Pause before the computer acts on its own (opening roll won by the bot, a
 * forced pass, legal plays still to load) so the board can be read first.
 * The bot's reply to a person's action is played inside that action by the
 * store, so it is not delayed here.
 */
const BOT_DELAY_MS = 650;

/**
 * After an engine failure during such an automatic step the store is left
 * with `ui.lastError` and nothing due for the person, so the page retries by
 * itself (`retryBotTurn()`) — this many times per turn, each after a longer
 * pause, which gives a worker still busy with a timed-out request time to
 * finish. Beyond that only a visible Retry control (the store's `canRetry`
 * and `retryBotTurn()`) or a new game moves on.
 */
const MAX_AUTO_RETRIES = 2;
const RETRY_DELAY_MS = 1_500;

/**
 * Creates the worker-backed engine and store on the client, starts the game
 * for `seed` once per game id, and hands the table to `TableLayout`.
 *
 * Opening an id whose record is stored under `bg.games.<id>` resumes that
 * record: a finished game is shown finished, an unfinished one continues
 * from its last turn (the store rebuilds the dice stream from the record).
 * A new game is only started when nothing is stored for the id.
 */
export function PlayGame({ gameId, seed, format, level }: PlayGameProps) {
  const router = useRouter();
  const [store] = useState(getGameStore);
  const startedFor = useRef<string | null>(null);
  const retries = useRef(0);
  const due = useStore(store, automaticActionDue);
  const busy = useStore(store, (s) => s.ui.busy);
  const failed = useStore(store, (s) => s.ui.lastError !== null);
  const retryable = useStore(store, canRetry);
  /** Changes whenever the game moves on; the automatic retries are counted per turn. */
  const progress = useStore(store, (s) => `${s.gameId ?? ""}:${String(s.record?.turns.length ?? 0)}`);

  useEffect(() => {
    if (startedFor.current === gameId) {
      return;
    }
    startedFor.current = gameId;
    void store.getState().newGame({ format, level, seed });
  }, [store, gameId, seed, format, level]);

  useEffect(() => {
    retries.current = 0;
  }, [progress]);

  useEffect(() => {
    if (!due || busy) {
      return;
    }
    if (!failed) {
      const timer = setTimeout(() => void store.getState().botTurn(), BOT_DELAY_MS);
      return () => clearTimeout(timer);
    }
    if (!retryable || retries.current >= MAX_AUTO_RETRIES) {
      return;
    }
    const attempt = retries.current + 1;
    const timer = setTimeout(() => {
      retries.current = attempt;
      void store.getState().retryBotTurn();
    }, RETRY_DELAY_MS * attempt);
    return () => clearTimeout(timer);
  }, [store, due, busy, failed, retryable]);

  const playAgain = useCallback(() => {
    router.push(gameHref(randomSeed(), { format, level }));
  }, [router, format, level]);

  return <TableLayout store={store} onPlayAgain={playAgain} />;
}
