/**
 * `localStorage` persistence for guest play: the board theme under
 * `bg.theme` and each local bot game's record under `bg.games.<id>` (kept
 * until piece E posts it to the server). Every access is guarded — storage
 * may be absent (server rendering, tests), disabled or full — and a failure
 * degrades to "nothing stored", never to an exception in the UI.
 */

import { THEME_IDS, type ThemeId } from "@/components/board/types";
import type { Record as GameRecord } from "@/engine/types";

/** The subset of the DOM `Storage` interface this module relies on. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export const THEME_KEY = "bg.theme";
export const GAMES_KEY_PREFIX = "bg.games.";
export const DEFAULT_THEME: ThemeId = "heritage";

/** `window.localStorage` when usable, else `null`. */
export function defaultStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

/** The id of a bot game played locally from `seed`: `local-<seed>`. */
export function localGameId(seed: number): string {
  return `local-${seed}`;
}

/** The seed of a `local-<seed>` id, or `null` for any other id. */
export function seedFromLocalGameId(id: string): number | null {
  const m = /^local-(\d{1,16})$/.exec(id);
  if (m === null) {
    return null;
  }
  const seed = Number(m[1]);
  return Number.isSafeInteger(seed) ? seed : null;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** The persisted theme, or `null` when none (or an unknown one) is stored. */
export function loadTheme(storage: StorageLike | null = defaultStorage()): ThemeId | null {
  try {
    const value = storage?.getItem(THEME_KEY) ?? null;
    return isThemeId(value) ? value : null;
  } catch {
    return null;
  }
}

/** Persists `theme`; returns `false` when storage is unavailable. */
export function saveTheme(theme: ThemeId, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    storage?.setItem(THEME_KEY, theme);
    return storage !== null;
  } catch {
    return false;
  }
}

const gameKey = (id: string): string => `${GAMES_KEY_PREFIX}${id}`;

/** Stores `record` under `bg.games.<id>`; returns `false` when storage is unavailable. */
export function saveLocalGame(id: string, record: GameRecord, storage: StorageLike | null = defaultStorage()): boolean {
  try {
    storage?.setItem(gameKey(id), JSON.stringify(record));
    return storage !== null;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is GameRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as { [key: string]: unknown };
  return (
    typeof r.seed === "number" &&
    typeof r.length === "number" &&
    typeof r.rules === "object" &&
    r.rules !== null &&
    Array.isArray(r.turns)
  );
}

/** The record stored under `bg.games.<id>`, or `null` when absent or malformed. */
export function loadLocalGame(id: string, storage: StorageLike | null = defaultStorage()): GameRecord | null {
  try {
    const text = storage?.getItem(gameKey(id)) ?? null;
    if (text === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function removeLocalGame(id: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(gameKey(id));
  } catch {
    // Nothing to remove, or storage unavailable.
  }
}

/** Ids of every locally stored game, in storage order. */
export function listLocalGameIds(storage: StorageLike | null = defaultStorage()): string[] {
  try {
    if (storage === null) {
      return [];
    }
    const ids: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(GAMES_KEY_PREFIX)) {
        ids.push(key.slice(GAMES_KEY_PREFIX.length));
      }
    }
    return ids;
  } catch {
    return [];
  }
}
