// Shared fixtures of the GameSession tests: an in-memory SessionStore that
// records every write (and can fail once on demand), a hand-fired timer, a
// `table()` that builds a session over the real wasm engine with an
// injectable clock, and the small drivers the suites repeat.

import { expect } from "vitest";

import { loadEngineNode, type EngineSync } from "../../src/engine/node";
import type { Record as GameRecord, ResultKind } from "../../src/engine/types";
import type { ChatLine, ClientMsg, SeatIndex, SeatInfo, ServerMsg, ServerMsgOf } from "../../src/realtime/protocol";
import { GameSession, type GameStatus, type HandleResult, type SessionStore, type SessionTimer, type StoredResult } from "../../src/realtime/session";

import { actorOf, clientMsg, pickPlay, seatOf, sendAccepted } from "./drive";

export class MemoryStore implements SessionStore {
  readonly turns: { gameId: string; record: GameRecord; status: GameStatus; result: StoredResult | null }[] = [];
  readonly chat: { gameId: string; line: ChatLine }[] = [];
  /** When set, the next `saveTurns` fails with it (once). */
  failNext: Error | null = null;

  saveTurns(gameId: string, record: GameRecord, status: GameStatus, result?: StoredResult): Promise<void> {
    if (this.failNext !== null) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    this.turns.push({ gameId, record: structuredClone(record), status, result: result ?? null });
    return Promise.resolve();
  }

  saveChat(gameId: string, line: ChatLine): Promise<void> {
    this.chat.push({ gameId, line });
    return Promise.resolve();
  }
}

export class FakeTimer implements SessionTimer {
  readonly pending: { fn: () => void; ms: number }[] = [];

  set(fn: () => void, ms: number): unknown {
    const handle = { fn, ms };
    this.pending.push(handle);
    return handle;
  }

  clear(handle: unknown): void {
    const i = this.pending.findIndex((h) => h === handle);
    if (i !== -1) {
      this.pending.splice(i, 1);
    }
  }

  fire(): void {
    const next = this.pending.shift();
    if (next === undefined) {
      throw new Error("no timer pending");
    }
    next.fn();
  }
}

export const SEATS: SeatInfo[] = [
  { seat: 0, name: "Alpha" },
  { seat: 1, name: "Beta" },
];

export interface Table {
  session: GameSession;
  store: MemoryStore;
  timer: FakeTimer;
  /** Everything the session broadcast on its own (timer-driven), in order. */
  unsolicited: ServerMsg[];
  clock: { now: number };
}

let engine: EngineSync | null = null;

/** The real engine, loaded once per process; call from `beforeAll`. */
export async function ensureEngine(): Promise<EngineSync> {
  engine ??= await loadEngineNode();
  return engine;
}

export interface TableOptions {
  seats?: SeatInfo[];
  store?: MemoryStore;
  status?: GameStatus;
  chat?: ChatLine[];
  lastActionAt?: number;
}

export function table(record: GameRecord, options: TableOptions = {}): Table {
  if (engine === null) {
    throw new Error("call ensureEngine() in beforeAll first");
  }
  const store = options.store ?? new MemoryStore();
  const timer = new FakeTimer();
  const unsolicited: ServerMsg[] = [];
  const clock = { now: 1_700_000_000_000 };
  const session = new GameSession({
    gameId: "game1",
    record,
    seats: options.seats ?? SEATS,
    engine,
    store,
    now: () => clock.now,
    timer,
    onBroadcast: (msgs) => unsolicited.push(...msgs),
    status: options.status,
    chat: options.chat,
    lastActionAt: options.lastActionAt,
  });
  return { session, store, timer, unsolicited, clock };
}

/** Both seats join; returns what each got. */
export async function joinBoth(session: GameSession) {
  const a = await session.handle(0, clientMsg("join"));
  const b = await session.handle(1, clientMsg("join"));
  return { a, b };
}

export const snapshotOf = (msgs: ServerMsg[]): ServerMsgOf<"snapshot">["game"] => {
  const snap = msgs.find((m) => m.type === "snapshot");
  if (snap === undefined || snap.type !== "snapshot") {
    throw new Error("no snapshot in reply");
  }
  return snap.game;
};

/** Sends `msg` and asserts it was refused with `code` and nothing was broadcast; returns the message text. */
export async function expectRejected(session: GameSession, seat: SeatIndex, msg: ClientMsg, code: string): Promise<string> {
  const { reply, broadcast } = await session.handle(seat, msg);
  expect(broadcast).toEqual([]);
  expect(reply).toHaveLength(1);
  expect(reply[0]).toMatchObject({ type: "rejected", id: msg.id, code });
  const message = reply[0].type === "rejected" ? reply[0].message : "";
  expect(message.length).toBeGreaterThan(0);
  return message;
}

/** Plays `session` (rolls and first legal plays only) until `player` is in `phase`. */
export async function playUntilTurnOf(session: GameSession, player: "white" | "black", phase: "toRoll" | "toMove"): Promise<void> {
  const sync = await ensureEngine();
  for (let i = 0; i < 200; i++) {
    const game = session.match.game;
    if (game.phase === phase && game.onRoll === player) {
      return;
    }
    const actor = actorOf(game);
    if (actor === null) {
      throw new Error(`nobody to act in ${game.phase}`);
    }
    const seat = seatOf(actor);
    if (game.phase === "toRoll") {
      await sendAccepted(session, seat, clientMsg("roll"));
    } else if (game.phase === "toMove") {
      await sendAccepted(session, seat, clientMsg("move", { play: pickPlay(sync, game) }));
    } else {
      throw new Error(`unexpected phase ${game.phase}`);
    }
  }
  throw new Error(`${player} never reached ${phase}`);
}

/** `seat` offers to resign as `kind` and the other seat accepts; returns the acceptance (whose broadcast ends the game). */
export async function resignAccepted(session: GameSession, seat: SeatIndex, kind: ResultKind): Promise<HandleResult> {
  const offered = await sendAccepted(session, seat, clientMsg("resign", { kind }));
  expect(offered.broadcast.map((m) => m.type)).toEqual(["resignOffered"]);
  return sendAccepted(session, seat === 0 ? 1 : 0, clientMsg("acceptResign"));
}

/** Ends the first game of a match by an accepted resignation as soon as the mover is to roll; returns once the session awaits the next game. */
export async function finishFirstGame(session: GameSession): Promise<void> {
  const sync = await ensureEngine();
  while (!session.awaitingNextGame) {
    const game = session.match.game;
    const actor = actorOf(game);
    if (actor === null) {
      throw new Error(`nobody to act in ${game.phase}`);
    }
    if (game.phase === "toRoll") {
      await resignAccepted(session, seatOf(actor), "single");
    } else {
      await sendAccepted(session, seatOf(actor), clientMsg("move", { play: pickPlay(sync, game) }));
    }
  }
}
