/**
 * Posting a finished bot game to the server once (plan Task 10; spec §5.5,
 * §8). The record under `bg.games.<id>` is sent to `POST /api/games`, which
 * replays and stores it; the server id comes back and is remembered under
 * `bg.games.<id>.posted` so a reload never posts the same game twice — the
 * server keeps no idempotency of its own. Nothing here blocks play: a
 * network failure or a 5xx is reported and left unmarked, so the next load
 * of the game tries again; a 400 (the server rejected the record) is
 * remembered as such, because the record will not become valid by waiting.
 *
 * Kept apart from the store on purpose: the store owns the game, this module
 * owns the one side effect after it.
 */

import type { Level, Record as GameRecord } from "@/engine/types";

import { defaultStorage, GAMES_KEY_PREFIX, type StorageLike } from "./local-games";

export const POSTED_SUFFIX = ".posted";
/** The White seat's name when the person has none (guest play). */
export const DEFAULT_GUEST_NAME = "Guest";
export const GAMES_ENDPOINT = "/api/games";

/** What `bg.games.<id>.posted` holds: the server's id, or why the server refused the record. */
export type PostedMarker = { serverId: string } | { rejected: string };

export type PostOutcome =
  | { status: "posted"; serverId: string }
  | { status: "already"; marker: PostedMarker }
  /** The server answered 400: remembered, never retried. */
  | { status: "rejected"; error: string }
  /** Network, 5xx, 429 or a malformed answer: not remembered, retried on the next load. */
  | { status: "failed"; error: string };

export interface PostFinishedGameOptions {
  /** The local game id (`local-<seed>`). */
  id: string;
  record: GameRecord;
  /** The computer's level: it sat at Black. */
  level: Level;
  /** The person's display name; blank falls back to `DEFAULT_GUEST_NAME`. */
  guestName?: string;
  /** `globalThis.fetch` by default; `null` when none is available. */
  fetch?: typeof fetch | null;
  storage?: StorageLike | null;
}

export const postedKey = (id: string): string => `${GAMES_KEY_PREFIX}${id}${POSTED_SUFFIX}`;

function isMarker(value: unknown): value is PostedMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const m = value as { serverId?: unknown; rejected?: unknown };
  return typeof m.serverId === "string" || typeof m.rejected === "string";
}

/** The marker stored for `id`, or `null` when the game was never posted (or the marker is unreadable). */
export function loadPostedMarker(id: string, storage: StorageLike | null = defaultStorage()): PostedMarker | null {
  try {
    const text = storage?.getItem(postedKey(id)) ?? null;
    if (text === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return isMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Remembers `marker` for `id`; `false` when storage is unavailable. */
export function savePostedMarker(id: string, marker: PostedMarker, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    storage?.setItem(postedKey(id), JSON.stringify(marker));
    return storage !== null;
  } catch {
    return false;
  }
}

/** The request body `POST /api/games` expects for a bot game: the person as White guest, the computer as Black. */
export function gamePostBody(record: GameRecord, level: Level, guestName?: string) {
  const name = guestName?.trim() ?? "";
  return {
    record,
    seats: {
      white: { kind: "guest" as const, name: name.length > 0 ? name : DEFAULT_GUEST_NAME },
      black: { kind: "bot" as const, level },
    },
  };
}

const defaultFetch = (): typeof fetch | null => (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function errorTextOf(response: Response): Promise<string> {
  // A 5xx body is generic by design (spec §8: the detail stays in the server
  // log), so the status is the part worth showing.
  if (response.status >= 500) {
    return `server error (HTTP ${String(response.status)})`;
  }
  try {
    const body: unknown = await response.json();
    const error = (body as { error?: unknown } | null)?.error;
    if (typeof error === "string" && error.length > 0) {
      return error;
    }
  } catch {
    // Not JSON: fall through to the status.
  }
  return `HTTP ${String(response.status)}`;
}

async function send(options: PostFinishedGameOptions, doFetch: typeof fetch, storage: StorageLike | null): Promise<PostOutcome> {
  let response: Response;
  try {
    response = await doFetch(GAMES_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(gamePostBody(options.record, options.level, options.guestName)),
    });
  } catch (failure) {
    return { status: "failed", error: messageOf(failure) };
  }
  if (response.status === 400) {
    const error = await errorTextOf(response);
    savePostedMarker(options.id, { rejected: error }, storage);
    return { status: "rejected", error };
  }
  if (!response.ok) {
    return { status: "failed", error: await errorTextOf(response) };
  }
  let serverId: unknown;
  try {
    serverId = ((await response.json()) as { id?: unknown } | null)?.id;
  } catch {
    serverId = undefined;
  }
  if (typeof serverId !== "string" || serverId.length === 0) {
    return { status: "failed", error: "the server did not return a game id" };
  }
  savePostedMarker(options.id, { serverId }, storage);
  return { status: "posted", serverId };
}

/** Posts in flight, one per local id: React's development double-effects and two tabs' worth of the same page share a request. */
const inFlight = new Map<string, Promise<PostOutcome>>();

/**
 * Posts the finished game `id` unless it was posted (or rejected) before.
 * Never throws: every failure is an outcome. Concurrent calls for one id
 * share the same request.
 */
export function postFinishedGame(options: PostFinishedGameOptions): Promise<PostOutcome> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const marker = loadPostedMarker(options.id, storage);
  if (marker !== null) {
    return Promise.resolve({ status: "already", marker });
  }
  const doFetch = options.fetch === undefined ? defaultFetch() : options.fetch;
  if (doFetch === null) {
    return Promise.resolve({ status: "failed", error: "fetch is not available" });
  }
  const pending = inFlight.get(options.id);
  if (pending !== undefined) {
    return pending;
  }
  const request = send(options, doFetch, storage).finally(() => inFlight.delete(options.id));
  inFlight.set(options.id, request);
  return request;
}
