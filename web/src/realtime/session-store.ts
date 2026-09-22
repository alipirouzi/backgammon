/**
 * Persistence of remote games for the realtime process (plan Task 3; spec
 * §5.5). `PrismaSessionStore` is the `SessionStore` a `GameSession` writes
 * through: one `Game` update per accepted action — `moveLog` and `status`,
 * plus `result` and `finishedAt` when the game ends, the same row shape the
 * review page reads through `getGame` — and one `ChatMessage` insert per
 * chat line. The update is guarded on the row still being `created` or
 * `active`: a session whose row the sweep abandoned meanwhile (or that a
 * stale process still holds after a finish) cannot resurrect it; the write
 * fails, the session keeps its state and the action is refused.
 *
 * `loadGameRow` and `loadSeats` turn rows into what `GameSession` is built
 * from: the record is validated by `parseRecord` (never trusted as-is), a
 * seat is named only once it is claimed (`seatSecretHash` set), the last
 * `MAX_CHAT_HISTORY` chat lines come back oldest first with their stored
 * timestamps, and `updatedAt` becomes the session's idle clock.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

import type { Record as GameRecord } from "@/engine/types";
import { parseRecord } from "@/server/validate";

import type { ChatLine, SeatIndex, SeatInfo } from "./protocol";
import { MAX_CHAT_HISTORY, type GameStatus, type SessionStore, type StoredResult } from "./session-types";

/** What the registry and the store need of Prisma. */
export type SessionDb = Pick<PrismaClient, "game" | "gameSeat" | "chatMessage">;

/** Statuses a session may still write to. */
export const LIVE_STATUSES: readonly GameStatus[] = ["created", "active"];

/** A write was refused because the row is no longer live (finished or abandoned meanwhile). */
export class SessionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStoreError";
  }
}

/** What a session is rebuilt from. */
export interface LoadedGame {
  record: GameRecord;
  seats: [SeatInfo, SeatInfo];
  chat: ChatLine[];
  status: GameStatus;
  /** `Game.updatedAt` in ms since the epoch: the last accepted action (or claim). */
  lastActionAt: number;
}

interface SeatRow {
  seat: number;
  guestName: string | null;
  seatSecretHash: string | null;
}

const COLOUR_NAME: { readonly [S in SeatIndex]: string } = { 0: "White", 1: "Black" };

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class PrismaSessionStore implements SessionStore {
  constructor(
    private readonly db: Pick<SessionDb, "game" | "chatMessage">,
    private readonly now: () => number = Date.now,
  ) {}

  async saveTurns(gameId: string, record: GameRecord, status: GameStatus, result?: StoredResult): Promise<void> {
    const finishing = status === "finished" && result !== undefined ? { result: asJson(result), finishedAt: new Date(this.now()) } : {};
    const { count } = await this.db.game.updateMany({
      where: { id: gameId, status: { in: [...LIVE_STATUSES] } },
      data: { moveLog: asJson(record), status, ...finishing },
    });
    if (count === 0) {
      throw new SessionStoreError(`game ${gameId} is not live any more (finished or abandoned): the action was not stored`);
    }
  }

  async saveChat(gameId: string, line: ChatLine): Promise<void> {
    await this.db.chatMessage.create({ data: { gameId, seat: line.seat, text: line.text, createdAt: new Date(line.at) } });
  }
}

/** The two seats as the table shows them: named once claimed, `null` while open. */
function seatInfos(rows: readonly SeatRow[]): [SeatInfo, SeatInfo] {
  const info = (seat: SeatIndex): SeatInfo => {
    const row = rows.find((r) => r.seat === seat);
    if (row === undefined || row.seatSecretHash === null) {
      return { seat, name: null };
    }
    return { seat, name: row.guestName ?? COLOUR_NAME[seat] };
  };
  return [info(0), info(1)];
}

/** The current seat rows of `gameId` (the invitee claims in the API process, not this one). */
export async function loadSeats(db: Pick<SessionDb, "gameSeat">, gameId: string): Promise<[SeatInfo, SeatInfo]> {
  const rows = await db.gameSeat.findMany({
    where: { gameId },
    select: { seat: true, guestName: true, seatSecretHash: true },
    orderBy: { seat: "asc" },
  });
  return seatInfos(rows);
}

/**
 * The game `gameId` as a session is built from it, or `null` when there is
 * no such row or it is not a remote game (bot games have no invite token
 * and never reach the realtime process). Throws when the stored record is
 * malformed.
 */
export async function loadGameRow(db: Pick<SessionDb, "game">, gameId: string): Promise<LoadedGame | null> {
  const row = await db.game.findUnique({
    where: { id: gameId },
    select: {
      id: true,
      token: true,
      status: true,
      moveLog: true,
      updatedAt: true,
      seats: { select: { seat: true, guestName: true, seatSecretHash: true }, orderBy: { seat: "asc" } },
      chat: { select: { seat: true, text: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: MAX_CHAT_HISTORY },
    },
  });
  if (row === null || row.token === null) {
    return null;
  }
  const seats = seatInfos(row.seats);
  const chat: ChatLine[] = row.chat
    .filter((line): line is typeof line & { seat: SeatIndex } => line.seat === 0 || line.seat === 1)
    .map((line) => ({ seat: line.seat, name: seats[line.seat].name ?? COLOUR_NAME[line.seat], text: line.text, at: line.createdAt.getTime() }))
    .reverse();
  return {
    record: parseRecord(row.moveLog),
    seats,
    chat,
    status: row.status,
    lastActionAt: row.updatedAt.getTime(),
  };
}
