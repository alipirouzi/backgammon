/**
 * The pure half of committing a turn in a `GameSession` (session.ts): from
 * the current record and state plus one judged `Turn`, what the record,
 * `MatchState`, status and result become — forfeits the engine forces
 * included — and the `state`/`gameOver` messages that announce it. Nothing
 * here touches the session or the store; the session persists `Derived`
 * and only then adopts it.
 */

import type { EngineSync } from "@/engine/sync";
import type { GameResult, MatchState, Record as GameRecord, Turn } from "@/engine/types";
import { appendTurn, moveTurn } from "@/game/record";

import type { ServerMsg } from "./protocol";
import { toWireRecord } from "./protocol-engine";
import { mustForfeit } from "./session-rules";
import { resultFromScore, type GameStatus, type StoredResult } from "./session-types";

/** What a committed action changes, computed before anything is persisted. */
export interface Derived {
  record: GameRecord;
  match: MatchState;
  status: GameStatus;
  /** The result of a game that just ended, if one did. */
  result: GameResult | null;
  matchOver: boolean;
  awaitingNextGame: boolean;
}

/**
 * Appends `turn` to `record` (and any forfeited turns it forces), replays,
 * and works out what changed against `before`. Throws if the engine refuses
 * the turn.
 */
export function deriveTurn(engine: EngineSync, record: GameRecord, before: MatchState, turn: Turn): Derived {
  let next = appendTurn(record, turn);
  let match = engine.replay(next);
  while (mustForfeit(engine, match.game)) {
    const g = match.game;
    next = appendTurn(next, moveTurn(g.onRoll!, g.dice!, ""));
    match = engine.replay(next);
  }
  const finished = match.game.phase === "finished";
  const rolledOver = before.game.phase !== "openingRoll" && match.game.phase === "openingRoll";
  const result = finished ? match.game.result : rolledOver ? resultFromScore(before, match) : null;
  return { record: next, match, status: finished ? "finished" : "active", result, matchOver: finished, awaitingNextGame: rolledOver };
}

/** What `Game.result` gets when the match (or money game) just ended; `undefined` otherwise. */
export function storedResultOf(derived: Derived): StoredResult | undefined {
  return derived.matchOver && derived.result !== null ? { ...derived.result, score: { ...derived.match.score } } : undefined;
}

/** The broadcast of a committed action: `state` (the seed revealed only on a finish) and, when a game ended, `gameOver`. */
export function stateMessages(derived: Derived): ServerMsg[] {
  const msgs: ServerMsg[] = [
    {
      type: "state",
      record: toWireRecord(derived.record, derived.status === "finished"),
      match: derived.match,
      awaitingNextGame: derived.awaitingNextGame,
      lastTurnIndex: derived.record.turns.length - 1,
    },
  ];
  if (derived.result !== null) {
    msgs.push({ type: "gameOver", result: derived.result, matchOver: derived.matchOver });
  }
  return msgs;
}
