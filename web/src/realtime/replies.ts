/**
 * What a `GameSession` answered to each seat's recent message ids, so a
 * message the client resends — its `ack` was lost with the socket, and the
 * browser transport resends whatever was not acknowledged — gets the same
 * answer again instead of a second execution (a chat line stored twice, a
 * resignation accepted twice, a `roll` taken as the next roll). Only the
 * last `REPLY_MEMORY` ids of a seat are kept; older ones are forgotten and
 * treated as new. `join` and `ping` are never stored (a reconnecting client
 * wants a fresh snapshot). The contract this creates for clients: ids must
 * be unique per seat across reconnects and page reloads (`crypto.randomUUID()`,
 * not a counter that restarts at 1).
 */

import type { SeatIndex, ServerMsg } from "./protocol";

/** Ids remembered per seat. */
export const REPLY_MEMORY = 50;

export class ReplyMemory {
  private readonly bySeat: readonly [Map<string, readonly ServerMsg[]>, Map<string, readonly ServerMsg[]>] = [new Map(), new Map()];

  /** The stored answer to `id` from `seat`, or `null` when none is remembered. */
  recall(seat: SeatIndex, id: string): readonly ServerMsg[] | null {
    return this.bySeat[seat].get(id) ?? null;
  }

  /** Stores `reply` as the answer to `id` from `seat`, forgetting the oldest id beyond `REPLY_MEMORY`. */
  remember(seat: SeatIndex, id: string, reply: readonly ServerMsg[]): void {
    const memory = this.bySeat[seat];
    memory.delete(id);
    memory.set(id, reply);
    for (const oldest of memory.keys()) {
      if (memory.size <= REPLY_MEMORY) {
        break;
      }
      memory.delete(oldest);
    }
  }
}
