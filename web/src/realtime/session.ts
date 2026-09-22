/**
 * `GameSession`: the authoritative in-memory state of one remote game (plan
 * Task 2; spec §5.4 "Clients never decide"). Pure with respect to sockets —
 * `handle(seat, msg)` returns what to send back to that seat (`reply`) and
 * what to send to both (`broadcast`); the WebSocket server (Task 4) does the
 * sending. The only outbound side effects are the injected `store`
 * (persistence) and, for the one state change no message triggers — the
 * next game of a match starting 30 s after the first vote — the injected
 * `onBroadcast`.
 *
 * As in bot games, the record is the single source of truth: an accepted
 * action appends exactly its `Turn`s, the `MatchState` is re-derived by the
 * engine's `replay` (which verifies dice, players and plays), the record is
 * persisted, and only then is the in-memory state replaced and the `state`
 * broadcast built. Dice come from `DiceRng` (the engine's generator ported
 * in `web/src/game/dice.ts`), positioned by `diceStreamAfter` on the stored
 * record so a resumed game stays in step. Because that stream is a function
 * of the seed, the record goes on the wire *without* its seed while the
 * game is live (`toWireRecord`); it is revealed once the game is over. A
 * turn with no legal move is forfeited by the server at once (the client
 * never sees a `toMove` it cannot play). Messages are processed one at a
 * time per session: two sockets cannot interleave a check with a commit.
 *
 * Resignation is an offer: `resign { kind }` from the player on roll is
 * priced by the rules and broadcast as `resignOffered`; the opponent's
 * `acceptResign` appends the resign turn (the game ends), `declineResign`
 * clears it, and any accepted game action of the offerer withdraws it. The
 * offer, like the next-game votes and their deadline, lives in memory only
 * — a restart forgets it — and is reported in every snapshot.
 *
 * Every answer to a message other than `join`/`ping` is remembered per seat
 * under its id (`replies.ts`): a resent id gets the same answer, once.
 *
 * Lifecycle: `created` until both seats are claimed and one of them joins
 * (the opening roll is drawn then, the game becomes `active`); between the
 * games of a match `awaitingNextGame` holds until both seats send
 * `nextGame` or 30 s pass after the first (when the store refuses that
 * opening roll it is retried with backoff — `NEXT_GAME_RETRY_MS` doubling,
 * `NEXT_GAME_RETRIES` times — and, those spent, again on the next frame
 * from either seat, `session-next-game.ts`); `finished`
 * once the money game is over or the match decided; `abandoned` (set by
 * the sweep, Task 3) and `finished` sessions are read-only — chat still
 * works, game actions get `gameOver`. A `saveTurns` failure leaves the state
 * untouched and propagates to the caller (no broadcast, nothing remembered
 * for the id); the client may retry.
 */

import type { EngineSync } from "@/engine/sync";
import type { MatchState, Record as GameRecord, Turn } from "@/engine/types";
import type { DiceRng } from "@/game/dice";
import { diceStreamAfter, openingRollTurn, resignTurn } from "@/game/record";

import { log } from "./log";
import {
  rejectedMessage,
  type ChatLine,
  type ClientMsg,
  type GameActionMsg,
  type RejectCode,
  type ResignAnswerMsg,
  type ResignOffer,
  type SeatIndex,
  type SeatInfo,
  type ServerMsg,
} from "./protocol";
import { toWireRecord } from "./protocol-engine";
import { ReplyMemory } from "./replies";
import { deriveTurn, stateMessages, storedResultOf, type Derived } from "./session-derive";
import { NextGameVote } from "./session-next-game";
import { judge, playerOfSeat } from "./session-rules";
import {
  MAX_CHAT_HISTORY,
  defaultTimer,
  isMatchOver,
  resignClearedMsg,
  resignOfferOf,
  resignOfferedMsg,
  seatsTuple,
  type GameSessionOptions,
  type GameStatus,
  type HandleResult,
  type SeatFlags,
  type SessionStore,
} from "./session-types";

export { REPLY_MEMORY } from "./replies";
export { MAX_CHAT_HISTORY, NEXT_GAME_RETRIES, NEXT_GAME_RETRY_MS, NEXT_GAME_TIMEOUT_MS, isMatchOver } from "./session-types";
export type { GameSessionOptions, GameStatus, HandleResult, SessionStore, SessionTimer, StoredResult } from "./session-types";

export class GameSession {
  readonly gameId: string;

  private readonly engine: EngineSync;
  private readonly store: SessionStore;
  private readonly now: () => number;
  private readonly onBroadcast: (msgs: ServerMsg[]) => void;
  private readonly replies = new ReplyMemory();
  private readonly nextGame: NextGameVote;

  private recordValue: GameRecord;
  private matchValue: MatchState;
  private statusValue: GameStatus;
  private seatsValue: [SeatInfo, SeatInfo];
  private presenceValue: SeatFlags = [false, false];
  private chatValue: readonly ChatLine[];
  private awaiting: boolean;
  private resignOffer: ResignOffer | null = null;
  private rng: DiceRng;
  private lastActionAtValue: number;
  /** Serialises `handle` calls and the timer's start. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GameSessionOptions) {
    this.gameId = options.gameId;
    this.engine = options.engine;
    this.store = options.store;
    this.now = options.now;
    this.nextGame = new NextGameVote(options.timer ?? defaultTimer, this.now, {
      gameId: this.gameId,
      enqueue: (task) => this.enqueue(task),
      start: async () => (this.awaiting && !this.readOnly ? this.commitOpeningRoll() : []),
      onBroadcast: (msgs) => this.onBroadcast(msgs),
    });
    this.onBroadcast = options.onBroadcast ?? (() => undefined);
    this.seatsValue = seatsTuple(options.seats);
    this.chatValue = (options.chat ?? []).slice(-MAX_CHAT_HISTORY);
    // Both throw on a record that does not follow its seed or the rules.
    this.rng = diceStreamAfter(options.record);
    this.recordValue = options.record;
    this.matchValue = this.engine.replay(options.record);
    const started = options.record.turns.length > 0;
    this.statusValue = isMatchOver(this.matchValue) ? "finished" : (options.status ?? (started ? "active" : "created"));
    this.awaiting = this.statusValue === "active" && started && this.matchValue.game.phase === "openingRoll";
    this.lastActionAtValue = options.lastActionAt ?? this.now();
  }

  get record(): GameRecord {
    return this.recordValue;
  }

  get match(): MatchState {
    return this.matchValue;
  }

  get status(): GameStatus {
    return this.statusValue;
  }

  get seats(): readonly SeatInfo[] {
    return this.seatsValue;
  }

  get presence(): SeatFlags {
    return [...this.presenceValue];
  }

  get chat(): readonly ChatLine[] {
    return this.chatValue;
  }

  get awaitingNextGame(): boolean {
    return this.awaiting;
  }

  /** When the last turn was committed (or the session created), on the injected clock; for the idle sweep. */
  get lastActionAt(): number {
    return this.lastActionAtValue;
  }

  /** The registry tells the session a seat was claimed (or renamed). */
  setSeat(seat: SeatIndex, info: SeatInfo): void {
    const next: [SeatInfo, SeatInfo] = [...this.seatsValue];
    next[seat] = { ...info, seat };
    this.seatsValue = next;
  }

  /** A seat came online or went offline; returns the `presence` broadcast. */
  setPresence(seat: SeatIndex, online: boolean): ServerMsg[] {
    const next: SeatFlags = [...this.presenceValue];
    next[seat] = online;
    this.presenceValue = next;
    return [{ type: "presence", presence: [...next] }];
  }

  /** Cancels the next-game timer; call when the session is evicted. */
  dispose(): void {
    this.nextGame.reset();
  }

  /** Processes one validated message from `seat`; calls are serialised per session. */
  handle(seat: SeatIndex, msg: ClientMsg): Promise<HandleResult> {
    return this.enqueue(() => this.process(seat, msg));
  }

  // -------------------------------------------------------------------------

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get readOnly(): boolean {
    return this.statusValue === "finished" || this.statusValue === "abandoned";
  }

  private get bothClaimed(): boolean {
    return this.seatsValue[0].name !== null && this.seatsValue[1].name !== null;
  }

  private async process(seat: SeatIndex, msg: ClientMsg): Promise<HandleResult> {
    // Any frame from either seat restarts a next game whose retries were spent.
    this.nextGame.resumeIfStalled();
    if (msg.type === "ping") {
      return { reply: [{ type: "pong" }], broadcast: [] };
    }
    if (msg.type === "join") {
      const broadcast = await this.ensureStarted();
      return { reply: [this.snapshot(seat), { type: "ack", id: msg.id }], broadcast };
    }
    const remembered = this.replies.recall(seat, msg.id);
    if (remembered !== null) {
      return { reply: [...remembered], broadcast: [] };
    }
    const result = await this.dispatch(seat, msg);
    this.replies.remember(seat, msg.id, result.reply);
    return result;
  }

  private dispatch(seat: SeatIndex, msg: Exclude<ClientMsg, { type: "join" | "ping" }>): Promise<HandleResult> {
    switch (msg.type) {
      case "chat":
        return this.chatFrom(seat, msg.id, msg.text);
      case "nextGame":
        return this.voteNextGame(seat, msg.id);
      case "acceptResign":
      case "declineResign":
        return this.answerResign(seat, msg);
      default:
        return this.gameAction(seat, msg);
    }
  }

  private snapshot(seat: SeatIndex): ServerMsg {
    return {
      type: "snapshot",
      game: {
        id: this.gameId,
        seat,
        status: this.statusValue,
        record: toWireRecord(this.recordValue, this.readOnly),
        match: this.matchValue,
        seats: [...this.seatsValue],
        awaitingNextGame: this.awaiting,
        nextGame: this.nextGame.info,
        resignOffer: this.resignOffer,
        presence: [...this.presenceValue],
        chat: [...this.chatValue],
      },
    };
  }

  private async chatFrom(seat: SeatIndex, id: string, text: string): Promise<HandleResult> {
    const name = this.seatsValue[seat].name ?? (playerOfSeat(seat) === "white" ? "White" : "Black");
    const line: ChatLine = { seat, name, text, at: this.now() };
    await this.store.saveChat(this.gameId, line);
    this.chatValue = [...this.chatValue, line].slice(-MAX_CHAT_HISTORY);
    return { reply: [{ type: "ack", id }], broadcast: [{ type: "chat", line }] };
  }

  /** The opening roll of the first game, once both seats are claimed and one of them joins. */
  private async ensureStarted(): Promise<ServerMsg[]> {
    const fresh = this.recordValue.turns.length === 0 && this.matchValue.game.phase === "openingRoll";
    if (this.readOnly || !fresh || !this.bothClaimed) {
      return [];
    }
    return this.commitOpeningRoll();
  }

  private async commitOpeningRoll(): Promise<ServerMsg[]> {
    const draft = this.rng.clone();
    return this.persist(this.derive(openingRollTurn(draft)), draft);
  }

  private derive(turn: Turn): Derived {
    return deriveTurn(this.engine, this.recordValue, this.matchValue, turn);
  }

  private async voteNextGame(seat: SeatIndex, id: string): Promise<HandleResult> {
    if (this.readOnly) {
      return this.refuse(id, "gameOver", "the game is over");
    }
    if (!this.awaiting) {
      return this.refuse(id, "wrongPhase", "no game is waiting to start");
    }
    if (this.nextGame.vote(seat)) {
      return { reply: [{ type: "ack", id }], broadcast: await this.commitOpeningRoll() };
    }
    this.nextGame.armTimeout();
    return { reply: [{ type: "ack", id }], broadcast: [] };
  }

  private refuse(id: string, code: RejectCode, message: string): HandleResult {
    return { reply: [rejectedMessage(id, code, message)], broadcast: [] };
  }

  /** The refusal every game action and resignation answer shares, or `null` when the game is in play. */
  private notInPlay(id: string): HandleResult | null {
    if (this.readOnly) {
      return this.refuse(id, "gameOver", "the game is over");
    }
    if (this.awaiting) {
      return this.refuse(id, "wrongPhase", "the next game has not started yet");
    }
    if (this.matchValue.game.phase === "openingRoll") {
      return this.refuse(id, "wrongPhase", this.bothClaimed ? "the game has not started yet" : "waiting for the opponent to join");
    }
    return null;
  }

  private async gameAction(seat: SeatIndex, msg: GameActionMsg): Promise<HandleResult> {
    const refused = this.notInPlay(msg.id);
    if (refused !== null) {
      return refused;
    }
    const verdict = judge(msg, seat, this.matchValue, this.engine, this.rng);
    if (!verdict.ok) {
      return this.refuse(msg.id, verdict.code, verdict.message);
    }
    if (msg.type === "resign") {
      const offer = resignOfferOf(seat, msg.kind, verdict.turn);
      this.resignOffer = offer;
      return { reply: [{ type: "ack", id: msg.id }], broadcast: [resignOfferedMsg(offer)] };
    }
    return this.commit(seat, msg.id, msg.type, verdict.turn, verdict.draft);
  }

  private async answerResign(seat: SeatIndex, msg: ResignAnswerMsg): Promise<HandleResult> {
    const refused = this.notInPlay(msg.id);
    if (refused !== null) {
      return refused;
    }
    const offer = this.resignOffer;
    if (offer === null) {
      return this.refuse(msg.id, "wrongPhase", "no resignation is offered");
    }
    if (offer.seat === seat) {
      return this.refuse(msg.id, "notYourTurn", "your opponent is to answer the offer");
    }
    if (msg.type === "declineResign") {
      this.resignOffer = null;
      return { reply: [{ type: "ack", id: msg.id }], broadcast: [resignClearedMsg(offer, "declined")] };
    }
    return this.commit(seat, msg.id, msg.type, resignTurn(playerOfSeat(offer.seat), offer.points), null);
  }

  /** Appends the judged `turn`, persists and broadcasts; a pending resignation offer is withdrawn (or, accepted, fulfilled) by it. */
  private async commit(seat: SeatIndex, id: string, type: string, turn: Turn, draft: DiceRng | null): Promise<HandleResult> {
    let derived: Derived;
    try {
      derived = this.derive(turn);
    } catch (error) {
      // The engine refused a turn the rules above let through: nothing was changed.
      const message = error instanceof Error ? error.message : String(error);
      log.warn("engine rejected a judged turn", { gameId: this.gameId, seat, type, message });
      return this.refuse(id, "illegal", message);
    }
    const withdrawn = turn.action === "resign" ? null : this.resignOffer;
    const broadcast = await this.persist(derived, draft);
    return { reply: [{ type: "ack", id }], broadcast: withdrawn === null ? broadcast : [resignClearedMsg(withdrawn, "withdrawn"), ...broadcast] };
  }

  /** Persists `derived`, then makes it the session's state; returns the broadcast. */
  private async persist(derived: Derived, draft: DiceRng | null): Promise<ServerMsg[]> {
    await this.store.saveTurns(this.gameId, derived.record, derived.status, storedResultOf(derived));
    this.recordValue = derived.record;
    this.matchValue = derived.match;
    this.statusValue = derived.status;
    if (draft !== null) {
      this.rng = draft.clone();
    }
    this.awaiting = derived.awaitingNextGame;
    this.resignOffer = null;
    this.nextGame.reset();
    this.lastActionAtValue = this.now();
    return stateMessages(derived);
  }
}
