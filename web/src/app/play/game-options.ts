/**
 * The URL contract between `/play/new` and `/play/local-<seed>`.
 *
 * A local bot game is identified by its seed alone (`local-<seed>`), so the
 * format and level travel as query parameters:
 *
 *   /play/local-42?format=single&level=beginner   money game
 *   /play/local-42?format=5&level=club            match to 5
 *
 * Both fall back to the defaults when absent or invalid, so a bare
 * `/play/local-42` (the screenshot matrix) still renders. `format` accepts
 * any match length from 1 to `MAX_MATCH_LENGTH`, not just the ones the form
 * offers; anything outside that range is treated like an absent parameter.
 */

import type { Level } from "@/engine/types";
import { MAX_SEED } from "@/game/record";
import type { GameFormat } from "@/game/store";

export interface GameOptions {
  format: GameFormat;
  level: Level;
}

export const MATCH_LENGTHS: readonly number[] = [3, 5, 7];

/**
 * Longest match the URL admits. The record itself allows up to 255 (`u8` in
 * `bg_core::Record`), but a match to more than 25 points is not a game anyone
 * plays and would only let a typo start an hours-long session.
 */
export const MAX_MATCH_LENGTH = 25;

export const LEVELS: readonly Level[] = ["beginner", "intermediate", "club"];

export const DEFAULT_OPTIONS: GameOptions = { format: "single", level: "intermediate" };

export const LEVEL_LABELS: { readonly [L in Level]: { name: string; blurb: string } } = {
  beginner: { name: "Beginner", blurb: "Plays quickly and forgives a lot." },
  intermediate: { name: "Intermediate", blurb: "A solid club-night opponent." },
  club: { name: "Club", blurb: "Full strength, with rollouts on close decisions." },
};

/** First value of a search parameter that may be repeated. */
type SearchValue = string | string[] | undefined;

const first = (value: SearchValue): string | undefined => (Array.isArray(value) ? value[0] : value);

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

/** `"single"` or an integer match length in `1..=MAX_MATCH_LENGTH`; anything else is `null`. */
export function parseFormat(value: SearchValue): GameFormat | null {
  const raw = first(value);
  if (raw === undefined) {
    return null;
  }
  if (raw === "single") {
    return "single";
  }
  if (!/^\d{1,3}$/.test(raw)) {
    return null;
  }
  const matchTo = Number(raw);
  return matchTo >= 1 && matchTo <= MAX_MATCH_LENGTH ? { matchTo } : null;
}

export function parseLevel(value: SearchValue): Level | null {
  const raw = first(value);
  return isLevel(raw) ? raw : null;
}

/** A dice seed from `?seed=`: a non-negative integer up to `MAX_SEED`, else `null`. */
export function parseSeed(value: SearchValue): number | null {
  const raw = first(value);
  if (raw === undefined || !/^\d{1,16}$/.test(raw)) {
    return null;
  }
  const seed = Number(raw);
  return Number.isSafeInteger(seed) && seed <= MAX_SEED ? seed : null;
}

/** The options a `/play/[gameId]` page was opened with, defaults filled in. */
export function optionsFromSearch(params: { [key: string]: SearchValue }): GameOptions {
  return {
    format: parseFormat(params.format) ?? DEFAULT_OPTIONS.format,
    level: parseLevel(params.level) ?? DEFAULT_OPTIONS.level,
  };
}

export const formatParam = (format: GameFormat): string => (format === "single" ? "single" : String(format.matchTo));

/** `/play/local-<seed>?format=…&level=…` */
export function gameHref(seed: number, options: GameOptions): string {
  const query = new URLSearchParams({ format: formatParam(options.format), level: options.level });
  return `/play/local-${String(seed)}?${query.toString()}`;
}
