// The realtime process's logger (web/src/realtime/log.ts): JSON lines,
// level threshold, child fields, errors flattened, nothing thrown.

import { describe, expect, it } from "vitest";

import { createLogger, isLogLevel, levelFromEnv } from "../../src/realtime/log";

function capture(level?: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const logger = createLogger({ level, write: (line) => lines.push(line), now: () => "2026-09-15T12:00:00.000Z" });
  const parsed = () => lines.map((l) => JSON.parse(l) as { [key: string]: unknown });
  return { logger, lines, parsed };
}

describe("createLogger", () => {
  it("writes one JSON object per line with timestamp, level, message and fields", () => {
    const { logger, parsed } = capture();
    logger.info("listening", { port: 4000 });
    expect(parsed()).toEqual([{ at: "2026-09-15T12:00:00.000Z", level: "info", msg: "listening", port: 4000 }]);
  });

  it("drops lines below the threshold (info by default)", () => {
    const { logger, lines } = capture();
    logger.debug("noise");
    logger.warn("careful");
    logger.error("broken");
    expect(lines).toHaveLength(2);
    const quiet = capture("error");
    quiet.logger.warn("careful");
    expect(quiet.lines).toHaveLength(0);
  });

  it("flattens errors, with the stack only at debug", () => {
    const { logger, parsed } = capture();
    logger.error("failed", { error: new RangeError("out of range") });
    expect(parsed()[0].error).toEqual({ name: "RangeError", message: "out of range" });
    const verbose = capture("debug");
    verbose.logger.error("failed", { error: new Error("x") });
    expect(verbose.parsed()[0].error).toMatchObject({ name: "Error", message: "x", stack: expect.stringContaining("Error: x") });
  });

  it("child loggers carry their fields on every line", () => {
    const { logger, parsed } = capture();
    logger.child({ gameId: "g1" }).info("joined", { seat: 0 });
    expect(parsed()[0]).toMatchObject({ gameId: "g1", seat: 0, msg: "joined" });
  });

  it("never throws on a field that cannot be serialised", () => {
    const { logger, parsed } = capture();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => logger.info("cyclic", { cyclic, big: BigInt(1) })).not.toThrow();
    expect(parsed()[0]).toMatchObject({ msg: "cyclic", cyclic: "[object Object]", big: "1" });
  });
});

describe("levelFromEnv", () => {
  it("reads LOG_LEVEL and falls back to info", () => {
    expect(levelFromEnv({ LOG_LEVEL: "debug" })).toBe("debug");
    expect(levelFromEnv({ LOG_LEVEL: "loud" })).toBe("info");
    expect(levelFromEnv({})).toBe("info");
    expect(isLogLevel("warn")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
  });
});
