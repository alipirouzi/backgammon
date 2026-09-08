// The URL contract between /play/new and /play/local-<seed>
// (web/src/app/play/game-options.ts): format and level as query parameters,
// the pinned dice seed, and the defaults a bare game URL falls back to.

import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  MAX_MATCH_LENGTH,
  formatParam,
  gameHref,
  optionsFromSearch,
  parseFormat,
  parseLevel,
  parseSeed,
} from "../src/app/play/game-options";
import { MAX_SEED } from "../src/game/record";

describe("parseFormat", () => {
  it("accepts 'single' and match lengths from 1 to MAX_MATCH_LENGTH", () => {
    expect(MAX_MATCH_LENGTH).toBe(25);
    expect(parseFormat("single")).toBe("single");
    expect(parseFormat("1")).toEqual({ matchTo: 1 });
    expect(parseFormat("7")).toEqual({ matchTo: 7 });
    expect(parseFormat("25")).toEqual({ matchTo: 25 });
    expect(parseFormat(["5", "3"])).toEqual({ matchTo: 5 });
  });

  it("rejects zero, negatives, words, absence and lengths the store would reject", () => {
    expect(parseFormat("0")).toBeNull();
    expect(parseFormat("-3")).toBeNull();
    expect(parseFormat("match")).toBeNull();
    expect(parseFormat("26")).toBeNull();
    expect(parseFormat("300")).toBeNull();
    expect(parseFormat("1000")).toBeNull();
    expect(parseFormat(undefined)).toBeNull();
  });

  it("falls back to the default format for an out-of-range match length", () => {
    expect(optionsFromSearch({ format: "300" })).toEqual(DEFAULT_OPTIONS);
  });
});

describe("parseLevel", () => {
  it("accepts the three engine levels only", () => {
    expect(parseLevel("beginner")).toBe("beginner");
    expect(parseLevel("intermediate")).toBe("intermediate");
    expect(parseLevel("club")).toBe("club");
    expect(parseLevel("grandmaster")).toBeNull();
    expect(parseLevel(undefined)).toBeNull();
  });
});

describe("parseSeed", () => {
  it("accepts non-negative safe integers up to MAX_SEED", () => {
    expect(parseSeed("42")).toBe(42);
    expect(parseSeed("0")).toBe(0);
    expect(parseSeed(String(MAX_SEED))).toBe(MAX_SEED);
  });

  it("rejects anything else", () => {
    expect(parseSeed(String(MAX_SEED + 1))).toBeNull();
    expect(parseSeed("-1")).toBeNull();
    expect(parseSeed("4.2")).toBeNull();
    expect(parseSeed("abc")).toBeNull();
    expect(parseSeed(undefined)).toBeNull();
  });
});

describe("optionsFromSearch / gameHref", () => {
  it("falls back to the defaults for a bare game URL", () => {
    expect(optionsFromSearch({})).toEqual(DEFAULT_OPTIONS);
    expect(optionsFromSearch({ format: "nonsense", level: "x" })).toEqual(DEFAULT_OPTIONS);
  });

  it("reads what gameHref wrote", () => {
    const href = gameHref(42, { format: { matchTo: 3 }, level: "club" });
    expect(href).toBe("/play/local-42?format=3&level=club");
    const search = Object.fromEntries(new URL(`http://x${href}`).searchParams);
    expect(optionsFromSearch(search)).toEqual({ format: { matchTo: 3 }, level: "club" });
    expect(gameHref(7, { format: "single", level: "beginner" })).toBe("/play/local-7?format=single&level=beginner");
    expect(formatParam("single")).toBe("single");
    expect(formatParam({ matchTo: 5 })).toBe("5");
  });
});
