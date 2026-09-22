/**
 * The vote between the games of a match (session.ts): who has sent
 * `nextGame`, and the timer that starts the game without the second vote —
 * 30 s after the first (`NEXT_GAME_TIMEOUT_MS`). When the attempt the timer
 * makes fails (the store refused the opening roll) it is retried with
 * backoff: `NEXT_GAME_RETRY_MS` doubling, `NEXT_GAME_RETRIES` times. Once
 * the retries are spent the vote is *stalled* — nothing is armed — until
 * the next frame from either seat (`resumeIfStalled`) restarts the sequence
 * at the base delay. Every attempt runs on the session's queue (`hooks.
 * enqueue`), so a frame arriving meanwhile sees its outcome. Memory only: a
 * session rebuilt from the row starts with no votes and no timer (the
 * snapshot says so through `startsAt: null`).
 */

import { log } from "./log";
import type { NextGameInfo, SeatIndex, ServerMsg } from "./protocol";
import { NEXT_GAME_RETRIES, NEXT_GAME_RETRY_MS, NEXT_GAME_TIMEOUT_MS, type SeatFlags, type SessionTimer } from "./session-types";

/** What the vote needs of its session. */
export interface NextGameHooks {
  gameId: string;
  /** Runs `task` serialised with the session's messages. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Draws and persists the opening roll; the broadcast to send, `[]` when no game is waiting any more. Rejects when the store refuses. */
  start(): Promise<ServerMsg[]>;
  /** Receives the broadcast of a game the timer started. */
  onBroadcast(msgs: ServerMsg[]): void;
}

export class NextGameVote {
  private votes: SeatFlags = [false, false];
  private handle: unknown = null;
  private startsAtValue: number | null = null;
  /** Attempts that failed since the last vote or restart, the timer's own included. */
  private failures = 0;

  constructor(
    private readonly timer: SessionTimer,
    private readonly now: () => number,
    private readonly hooks: NextGameHooks,
  ) {}

  /** For the snapshot: the votes and when the armed timer fires (`null` while none is armed). */
  get info(): NextGameInfo {
    return { votes: [...this.votes], startsAt: this.startsAtValue };
  }

  get armed(): boolean {
    return this.handle !== null;
  }

  /** A vote stands, nothing is armed and the retries are spent: waiting for a frame. */
  get stalled(): boolean {
    return (this.votes[0] || this.votes[1]) && !this.armed && this.failures > NEXT_GAME_RETRIES;
  }

  /** Records `seat`'s vote; `true` once both seats have voted. */
  vote(seat: SeatIndex): boolean {
    const votes: SeatFlags = [...this.votes];
    votes[seat] = true;
    this.votes = votes;
    return votes[0] && votes[1];
  }

  /** Arms the 30 s timer after a first vote; a no-op while a timer is armed. */
  armTimeout(): void {
    if (!this.armed) {
      this.arm(NEXT_GAME_TIMEOUT_MS);
    }
  }

  /** A frame arrived: a stalled vote gets its retries back and a timer at the base delay. */
  resumeIfStalled(): void {
    if (this.stalled) {
      this.failures = 0;
      this.arm(NEXT_GAME_RETRY_MS);
    }
  }

  /** Cancels the timer and forgets votes and failures (a game started, or the session is disposed). */
  reset(): void {
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
    this.startsAtValue = null;
    this.votes = [false, false];
    this.failures = 0;
  }

  // -------------------------------------------------------------------------

  private arm(ms: number): void {
    this.handle = this.timer.set(() => {
      this.handle = null;
      this.onTimeout();
    }, ms);
    this.startsAtValue = this.now() + ms;
  }

  /** The timer fired: start the game, or count the failure and retry — on the session's queue. */
  private onTimeout(): void {
    void this.hooks.enqueue(async () => {
      try {
        const msgs = await this.hooks.start();
        if (msgs.length > 0) {
          this.hooks.onBroadcast(msgs);
        }
      } catch (error: unknown) {
        this.retry(error);
      }
    });
  }

  /** After a failed attempt: arm the next retry (5 s, 10 s, 20 s), or — the retries spent — log and wait for a frame. */
  private retry(error: unknown): void {
    this.failures += 1;
    if (this.failures > NEXT_GAME_RETRIES) {
      log.error("next game could not start on the timer; retries spent, waiting for the next frame", { gameId: this.hooks.gameId, error });
      return;
    }
    const retryInMs = NEXT_GAME_RETRY_MS * 2 ** (this.failures - 1);
    log.error("next game could not start on the timer", { gameId: this.hooks.gameId, error, retryInMs });
    // The attempt ran on the queue, so no vote could arm a timer meanwhile; the check is belt and braces.
    if (!this.armed) {
      this.arm(retryInMs);
    }
  }
}
