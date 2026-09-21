// Scripted players for a GameSession (Vitest only; the framework-free
// picking rules live in pick.ts, shared with the two-browser e2e of plan
// Task 9): each seat always plays the first legal play the engine lists,
// takes every double, accepts every resignation offered, and — when the
// test says so — doubles or offers to resign.
// Nothing here knows the rules: whose turn it is comes from the engine's
// phase, the plays from `legalPlays`, and every answer of the session is
// checked for a rejection so a test fails at the first refused action.

import { expect } from "vitest";

import type { EngineSync } from "../../src/engine/sync";
import type { MatchState, ResultKind } from "../../src/engine/types";
import type { ClientMsg, SeatIndex, ServerMsg } from "../../src/realtime/protocol";
import type { GameSession, HandleResult } from "../../src/realtime/session";

import { actorOf, cubeAvailable, pickPlay, seatOf } from "./pick";

export { actorOf, cubeAvailable, opponentOf, pickPlay, seatOf } from "./pick";

let nextId = 0;

/** A fresh client message id. */
export const msgId = (): string => `m${String(++nextId)}`;

type Extra<T extends ClientMsg["type"]> = Omit<Extract<ClientMsg, { type: T }>, "id" | "type">;

/** A client message with a fresh id. */
export function clientMsg<T extends ClientMsg["type"]>(type: T, extra?: Extra<T>): Extract<ClientMsg, { type: T }> {
  return { id: msgId(), type, ...(extra ?? {}) } as Extract<ClientMsg, { type: T }>;
}

export interface DriveContext {
  /** Games decided so far in this drive. */
  games: number;
  /** Accepted actions so far, oldest first (`"roll"`, `"double"`, `"take"`, `"resign"`, `"next"`, or a notation). */
  actions: string[];
  match: MatchState;
  seat: SeatIndex;
}

export interface DriveDecisions {
  /** Offer a double now; consulted only when the cube is available to the actor. */
  double?: (ctx: DriveContext) => boolean;
  /** Resign as this kind now; consulted only when the actor is on roll. */
  resign?: (ctx: DriveContext) => ResultKind | null;
  /** Stop after this many accepted actions (for resume tests); unbounded by default. */
  maxActions?: number;
}

export interface DriveLog {
  actions: string[];
  /** `gameOver` messages seen, in order. */
  gameOvers: Extract<ServerMsg, { type: "gameOver" }>[];
  /** `state` messages seen, in order. */
  states: Extract<ServerMsg, { type: "state" }>[];
  /** `true` when `maxActions` stopped the drive before the end. */
  stopped: boolean;
}

/** Sends `msg` for `seat` and fails the test if the session refused it. */
export async function sendAccepted(session: GameSession, seat: SeatIndex, msg: ClientMsg): Promise<HandleResult> {
  const result = await session.handle(seat, msg);
  const refused = result.reply.find((m) => m.type === "rejected");
  if (refused !== undefined) {
    throw new Error(`seat ${String(seat)} ${msg.type} refused: ${refused.code} ${refused.message}`);
  }
  expect(result.reply).toContainEqual({ type: "ack", id: msg.id });
  return result;
}

const MAX_STEPS = 4000;

/**
 * Plays both seats until the money game or the match is over: first legal
 * play, take every double, vote for the next game from both seats between
 * the games of a match. Returns what was seen.
 */
export async function driveSession(session: GameSession, engine: EngineSync, decide: DriveDecisions = {}): Promise<DriveLog> {
  const log: DriveLog = { actions: [], gameOvers: [], states: [], stopped: false };
  const maxActions = decide.maxActions ?? Number.POSITIVE_INFINITY;

  const send = async (seat: SeatIndex, msg: ClientMsg, label: string | null): Promise<void> => {
    const { broadcast } = await sendAccepted(session, seat, msg);
    for (const m of broadcast) {
      if (m.type === "gameOver") {
        log.gameOvers.push(m);
      } else if (m.type === "state") {
        log.states.push(m);
      }
    }
    if (label !== null) {
      log.actions.push(label);
    }
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (log.actions.length >= maxActions) {
      log.stopped = true;
      return log;
    }
    const match = session.match;
    if (session.status === "finished" || match.game.phase === "finished") {
      expect(session.status).toBe("finished");
      return log;
    }
    if (session.awaitingNextGame) {
      await send(0, clientMsg("nextGame"), "next");
      expect(session.awaitingNextGame).toBe(true);
      await send(1, clientMsg("nextGame"), "next");
      expect(session.awaitingNextGame).toBe(false);
      continue;
    }
    const game = match.game;
    const actor = actorOf(game);
    if (actor === null) {
      throw new Error(`nobody to act in phase ${game.phase} after ${log.actions.join(", ")}`);
    }
    const seat = seatOf(actor);
    const ctx: DriveContext = { games: log.gameOvers.length, actions: log.actions, match, seat };
    switch (game.phase) {
      case "doubled":
        await send(seat, clientMsg("take"), "take");
        break;
      case "toRoll": {
        const kind = decide.resign?.(ctx) ?? null;
        if (kind !== null) {
          // The offer and its acceptance are one action of the drive: the resignation.
          await send(seat, clientMsg("resign", { kind }), null);
          await send(seat === 0 ? 1 : 0, clientMsg("acceptResign"), "resign");
        } else if (cubeAvailable(match, actor) && decide.double?.(ctx) === true) {
          await send(seat, clientMsg("double"), "double");
        } else {
          await send(seat, clientMsg("roll"), "roll");
        }
        break;
      }
      case "toMove": {
        const play = pickPlay(engine, game);
        await send(seat, clientMsg("move", { play }), play);
        break;
      }
      default:
        throw new Error(`unexpected phase ${game.phase}`);
    }
  }
  throw new Error(`the game did not finish within ${String(MAX_STEPS)} steps`);
}
