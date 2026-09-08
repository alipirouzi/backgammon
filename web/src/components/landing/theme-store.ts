// Theme persistence shared by the landing's board chooser. The active theme
// lives in one place — `data-theme` on <html> — and is remembered under the
// localStorage key from the plan ('bg.theme') as the raw theme id.
// Pure helpers take their DOM/storage handles as arguments so they run in Node.

import { THEME_IDS } from "../board/types";
import type { ThemeId } from "../board/types";

export const THEME_STORAGE_KEY = "bg.theme";
export const THEME_ATTRIBUTE = "data-theme";
export const DEFAULT_THEME: ThemeId = "heritage";

export interface ThemeRoot {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as readonly string[]).includes(value);
}

/** The stored theme id (raw or JSON-encoded), or null when absent, invalid or unreadable. */
export function readStoredTheme(storage: ThemeStorage | null | undefined): ThemeId | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage access can be denied (privacy mode, blocked site data); treat as empty.
    return null;
  }
  if (raw === null) return null;
  if (isThemeId(raw)) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isThemeId(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The theme currently set on the document root, defaulting to heritage. */
export function readDocumentTheme(root: ThemeRoot): ThemeId {
  const value = root.getAttribute(THEME_ATTRIBUTE);
  return isThemeId(value) ? value : DEFAULT_THEME;
}

/** Sets the theme on the root and persists it; persistence is best-effort. */
export function applyTheme(
  theme: ThemeId,
  { root, storage }: { root: ThemeRoot; storage: ThemeStorage | null | undefined },
): void {
  root.setAttribute(THEME_ATTRIBUTE, theme);
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Quota exceeded or storage blocked: the theme still applies for this visit.
  }
}

/** `window.localStorage` when available, otherwise null (SSR, blocked storage). */
export function browserStorage(): ThemeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
