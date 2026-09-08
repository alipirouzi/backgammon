// Engine client (web/src/engine/client.ts) against a fake Worker: one
// request in flight at a time, FIFO results, engine errors propagated with
// their message, 10 s timeout with a clear error and stale replies dropped,
// terminate() rejecting everything, and the default Worker construction.
// Also the request dispatcher (sync.ts) and MockEngine scripting.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEngine,
  DEFAULT_TIMEOUT_MS,
  EngineError,
  MockEngine,
  type Engine,
  type WorkerLike,
} from "../src/engine/client";
import { isRes, type AnyReqBody, type Req, type Res } from "../src/engine/protocol";
import { asRawBgWasm, dispatch, wrapRawEngine, type RawBgWasm } from "../src/engine/sync";
import type { Board, Dice, MatchContext, Play, Record as GameRecord } from "../src/engine/types";

const OPENING: Board = {
  white: [0, 0, 0, 0, 0, 0, 5, 0, 3, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0],
  black: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 3, 0, 5, 0, 0, 0, 0, 0, 0],
};
const DICE: Dice = { hi: 3, lo: 1 };
const MONEY: MatchContext = {
  length: 0,
  myAway: 0,
  theirAway: 0,
  crawford: false,
  postCrawford: false,
  cube: 1,
  cubeOwnerIsMe: null,
};
const PLAY: Play = {
  moves: [
    { from: 8, to: 5, hit: false },
    { from: 6, to: 5, hit: false },
  ],
  notation: "8/5 6/5",
};
const RECORD: GameRecord = {
  seed: 42,
  length: 7,
  rules: { jacoby: false, beavers: false, autoDoubles: false },
  turns: [],
};

/** A Worker double: records posted requests and lets the test reply by id. */
class FakeWorker implements WorkerLike {
  readonly posted: Req[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(message: unknown): void {
    this.posted.push(message as Req);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(res: Res): void {
    this.onmessage?.({ data: res } as MessageEvent);
  }

  ok(id: number, result: unknown): void {
    this.reply({ id, ok: true, result });
  }

  fail(id: number, error: string): void {
    this.reply({ id, ok: false, error });
  }

  crash(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  get last(): Req {
    const req = this.posted.at(-1);
    if (req === undefined) {
      throw new Error("nothing posted");
    }
    return req;
  }
}

/** Lets promise callbacks queued by a reply run before asserting. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("createEngine", () => {
  let worker: FakeWorker;
  let engine: Engine;
  let constructed = 0;

  beforeEach(() => {
    // Only the request timeout is faked; `setImmediate` stays real for `flush()`.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    worker = new FakeWorker();
    constructed = 0;
    engine = createEngine({
      workerFactory: () => {
        constructed += 1;
        return worker;
      },
    });
  });

  afterEach(() => {
    engine.terminate();
    vi.useRealTimers();
  });

  it("spawns the worker lazily, on the first call", () => {
    expect(constructed).toBe(0);
    void engine.version().catch(() => undefined);
    expect(constructed).toBe(1);
    void engine.version().catch(() => undefined);
    expect(constructed).toBe(1);
  });

  it("posts a typed request with an id and resolves with the parsed result", async () => {
    const promise = engine.legalPlays(OPENING, "white", DICE);
    expect(worker.posted).toHaveLength(1);
    expect(worker.last).toEqual({ id: 1, type: "legalPlays", board: OPENING, onRoll: "white", dice: DICE });
    worker.ok(1, [PLAY]);
    await expect(promise).resolves.toEqual([PLAY]);
  });

  it("maps every method to its request shape", async () => {
    const calls: [Promise<unknown>, Req][] = [];
    const push = (p: Promise<unknown>, expected: AnyReqBody): void => {
      calls.push([p, { ...expected, id: calls.length + 1 } as Req]);
    };
    push(engine.applyPlay(OPENING, "white", PLAY), { type: "applyPlay", board: OPENING, onRoll: "white", play: PLAY });
    push(engine.applyPlay(OPENING, "black", "24/18 13/10"), {
      type: "applyPlay",
      board: OPENING,
      onRoll: "black",
      play: "24/18 13/10",
    });
    push(engine.choosePlay(OPENING, "white", DICE, MONEY, "club", 7), {
      type: "choosePlay",
      board: OPENING,
      onRoll: "white",
      dice: DICE,
      matchCtx: MONEY,
      level: "club",
      seed: 7,
    });
    push(engine.cubeAction(OPENING, "black", MONEY, "beginner"), {
      type: "cubeAction",
      board: OPENING,
      onRoll: "black",
      matchCtx: MONEY,
      level: "beginner",
    });
    push(engine.analyzePlay(OPENING, "white", DICE, MONEY, "8/5 6/5", 3), {
      type: "analyzePlay",
      board: OPENING,
      onRoll: "white",
      dice: DICE,
      matchCtx: MONEY,
      played: "8/5 6/5",
      seed: 3,
    });
    push(engine.replay(RECORD), { type: "replay", record: RECORD });
    push(engine.version(), { type: "version" });

    for (const [i, [promise, expected]] of calls.entries()) {
      expect(worker.posted).toHaveLength(i + 1);
      expect(worker.last).toEqual(expected);
      worker.ok(expected.id, `result ${i}`);
      await expect(promise).resolves.toBe(`result ${i}`);
    }
  });

  it("keeps one request in flight and delivers results in call order", async () => {
    const first = engine.version();
    const second = engine.legalPlays(OPENING, "white", DICE);
    const third = engine.replay(RECORD);
    expect(worker.posted.map((r) => r.type)).toEqual(["version"]);

    worker.ok(1, "bg-wasm 0.1.0");
    await flush();
    expect(worker.posted.map((r) => r.type)).toEqual(["version", "legalPlays"]);

    worker.ok(2, [PLAY]);
    await flush();
    expect(worker.posted.map((r) => r.type)).toEqual(["version", "legalPlays", "replay"]);

    const order: string[] = [];
    void first.then(() => order.push("first"));
    void second.then(() => order.push("second"));
    void third.then(() => order.push("third"));
    worker.ok(3, { length: 7 });
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("rejects with the engine's message when the worker reports an error, then continues", async () => {
    const bad = engine.legalPlays(OPENING, "white", { hi: 7, lo: 1 });
    const good = engine.version();
    worker.fail(1, "invalid dice: die out of range");
    await expect(bad).rejects.toMatchObject({
      name: "EngineError",
      kind: "engine",
      method: "legalPlays",
      message: "invalid dice: die out of range",
    });
    await expect(bad).rejects.toBeInstanceOf(EngineError);
    await flush();
    expect(worker.last.type).toBe("version");
    worker.ok(2, "bg-wasm 0.1.0");
    await expect(good).resolves.toBe("bg-wasm 0.1.0");
  });

  it("times out after 10 s with a clear error and ignores the late reply", async () => {
    const slow = engine.choosePlay(OPENING, "white", DICE, MONEY, "club", 1);
    const next = engine.version();
    const rejection = expect(slow).rejects.toMatchObject({
      kind: "timeout",
      method: "choosePlay",
      message: expect.stringMatching(/choosePlay timed out after 10000 ms/) as string,
    });

    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS - 1);
    expect(worker.posted).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await rejection;
    await flush();

    // The queue moved on; the stale reply for id 1 must not disturb id 2.
    expect(worker.last).toEqual({ id: 2, type: "version" });
    worker.ok(1, { play: PLAY, candidates: [] });
    worker.ok(2, "bg-wasm 0.1.0");
    await expect(next).resolves.toBe("bg-wasm 0.1.0");
  });

  it("honours a custom timeout", async () => {
    const quick = createEngine({ timeoutMs: 50, workerFactory: () => new FakeWorker() });
    const promise = quick.version();
    vi.advanceTimersByTime(50);
    await expect(promise).rejects.toThrow(/timed out after 50 ms/);
    quick.terminate();
  });

  it("does not time out a request that was answered in time", async () => {
    const promise = engine.version();
    worker.ok(1, "bg-wasm 0.1.0");
    await promise;
    vi.advanceTimersByTime(DEFAULT_TIMEOUT_MS * 2);
    await expect(promise).resolves.toBe("bg-wasm 0.1.0");
  });

  it("rejects the in-flight request when the worker itself errors", async () => {
    const promise = engine.version();
    worker.crash("Uncaught RuntimeError: unreachable");
    await expect(promise).rejects.toMatchObject({
      kind: "worker",
      message: "engine worker failed: Uncaught RuntimeError: unreachable",
    });
  });

  it("discards a crashed worker and spawns a fresh one for the next request", async () => {
    const workers: FakeWorker[] = [];
    const respawning = createEngine({
      workerFactory: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    const first = respawning.version();
    const queued = respawning.replay(RECORD);
    workers[0].crash("Uncaught RuntimeError: unreachable");
    await expect(first).rejects.toMatchObject({ kind: "worker", method: "version" });
    // The dead instance is stopped and detached; the queued request went to a new worker at once.
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].onmessage).toBeNull();
    expect(workers).toHaveLength(2);
    expect(workers[1].last).toMatchObject({ type: "replay" });
    workers[1].ok(workers[1].last.id, RECORD);
    await expect(queued).resolves.toEqual(RECORD);
    // A later request also reaches the live worker, not the dead one.
    const later = respawning.version();
    expect(workers).toHaveLength(2);
    workers[1].ok(workers[1].last.id, "bg-wasm 0.1.0");
    await expect(later).resolves.toBe("bg-wasm 0.1.0");
    expect(workers[0].posted).toHaveLength(1);
    respawning.terminate();
  });

  it("terminate() rejects pending calls, stops the worker and refuses later calls", async () => {
    const inFlight = engine.version();
    const queued = engine.replay(RECORD);
    engine.terminate();
    await expect(inFlight).rejects.toMatchObject({ kind: "terminated", method: "version" });
    await expect(queued).rejects.toMatchObject({ kind: "terminated", method: "replay" });
    expect(worker.terminated).toBe(true);
    await expect(engine.version()).rejects.toMatchObject({
      kind: "terminated",
      message: "engine: version called after terminate()",
    });
    engine.terminate(); // idempotent
    // A reply after termination is ignored.
    expect(() => worker.ok(1, "late")).not.toThrow();
  });

  it("ignores messages that are not protocol responses", async () => {
    const promise = engine.version();
    worker.onmessage?.({ data: "hello" } as MessageEvent);
    worker.onmessage?.({ data: { id: "1", ok: true } } as MessageEvent);
    worker.ok(1, "bg-wasm 0.1.0");
    await expect(promise).resolves.toBe("bg-wasm 0.1.0");
  });
});

describe("createEngine default worker", () => {
  const original = globalThis.Worker;

  afterEach(() => {
    if (original === undefined) {
      // @ts-expect-error restoring an absent global
      delete globalThis.Worker;
    } else {
      globalThis.Worker = original;
    }
  });

  it("constructs a module Worker from ./worker.ts", () => {
    const seen: { url: string; options: unknown }[] = [];
    class StubWorker {
      onmessage = null;
      onerror = null;
      constructor(url: URL | string, options?: WorkerOptions) {
        seen.push({ url: String(url), options });
      }
      postMessage(): void {}
      terminate(): void {}
    }
    globalThis.Worker = StubWorker as unknown as typeof Worker;

    const engine = createEngine();
    void engine.version().catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname.endsWith("/src/engine/worker.ts")).toBe(true);
    expect(seen[0].options).toEqual({ type: "module" });
    engine.terminate();
  });

  it("rejects with a clear message when Worker is unavailable", async () => {
    // @ts-expect-error simulating a server environment
    delete globalThis.Worker;
    const engine = createEngine();
    await expect(engine.version()).rejects.toMatchObject({
      kind: "worker",
      message: expect.stringMatching(/Web Workers are not available/) as string,
    });
  });
});

describe("protocol", () => {
  it("isRes accepts well-formed responses only", () => {
    expect(isRes({ id: 1, ok: true, result: null })).toBe(true);
    expect(isRes({ id: 1, ok: false, error: "boom" })).toBe(true);
    expect(isRes({ id: 1, ok: false })).toBe(false);
    expect(isRes({ id: "1", ok: true })).toBe(false);
    expect(isRes(null)).toBe(false);
    expect(isRes("x")).toBe(false);
  });
});

describe("dispatch over a raw bg-wasm module", () => {
  const log: { fn: string; args: string[] }[] = [];
  const record =
    (fn: string, out: unknown) =>
    (...args: string[]): string => {
      log.push({ fn, args });
      return typeof out === "string" && fn === "version" ? out : JSON.stringify(out);
    };
  const raw: RawBgWasm = {
    opening_board: record("opening_board", OPENING),
    legal_plays: record("legal_plays", [PLAY]),
    apply_play: record("apply_play", OPENING),
    choose_play: record("choose_play", { play: PLAY, candidates: [] }),
    cube_action: record("cube_action", { action: "noDouble", canDouble: true }),
    analyze_play: record("analyze_play", { candidates: [], playedIndex: 0, errorSize: 0, category: "best" }),
    replay: record("replay", { length: 7 }),
    version: record("version", "bg-wasm 0.1.0"),
  };
  const engine = wrapRawEngine(raw);

  beforeEach(() => {
    log.length = 0;
  });

  it("stringifies every argument positionally and parses the result", () => {
    const result = dispatch(engine, { id: 1, type: "choosePlay", board: OPENING, onRoll: "white", dice: DICE, matchCtx: MONEY, level: "club", seed: 12 });
    expect(result).toEqual({ play: PLAY, candidates: [] });
    expect(log).toEqual([
      {
        fn: "choose_play",
        args: [JSON.stringify(OPENING), '"white"', JSON.stringify(DICE), JSON.stringify(MONEY), '"club"', "12"],
      },
    ]);
  });

  it("routes each request type to its export", () => {
    dispatch(engine, { id: 1, type: "legalPlays", board: OPENING, onRoll: "white", dice: DICE });
    dispatch(engine, { id: 2, type: "applyPlay", board: OPENING, onRoll: "black", play: "24/18" });
    dispatch(engine, { id: 3, type: "cubeAction", board: OPENING, onRoll: "white", matchCtx: MONEY, level: "beginner" });
    dispatch(engine, { id: 4, type: "analyzePlay", board: OPENING, onRoll: "white", dice: DICE, matchCtx: MONEY, played: "8/5 6/5", seed: 3 });
    dispatch(engine, { id: 5, type: "replay", record: RECORD });
    expect(dispatch(engine, { id: 6, type: "version" })).toBe("bg-wasm 0.1.0");
    expect(log.map((l) => l.fn)).toEqual(["legal_plays", "apply_play", "cube_action", "analyze_play", "replay", "version"]);
    expect(log[1].args).toEqual([JSON.stringify(OPENING), '"black"', '"24/18"']);
    expect(log[3].args[4]).toBe('"8/5 6/5"');
    expect(log[3].args[5]).toBe("3");
  });

  it("rejects an unknown request type and a module missing exports", () => {
    expect(() => dispatch(engine, { id: 1, type: "nope" } as unknown as Req)).toThrow(/unknown engine request type: nope/);
    expect(() => asRawBgWasm({ version: () => "x" })).toThrow(/missing exports: analyze_play, apply_play/);
    expect(() => asRawBgWasm(null)).toThrow(/missing exports/);
  });
});

describe("MockEngine", () => {
  it("serves scripted responses FIFO and records calls", async () => {
    const mock = new MockEngine();
    mock.script("legalPlays", [PLAY], []);
    await expect(mock.legalPlays(OPENING, "white", DICE)).resolves.toEqual([PLAY]);
    await expect(mock.legalPlays(OPENING, "black", DICE)).resolves.toEqual([]);
    expect(mock.calls).toEqual([
      { method: "legalPlays", args: [OPENING, "white", DICE] },
      { method: "legalPlays", args: [OPENING, "black", DICE] },
    ]);
    expect(mock.callsTo("legalPlays")[1][1]).toBe("black");
  });

  it("supports function responses, Error responses and fallbacks", async () => {
    const mock = new MockEngine();
    mock.always("applyPlay", (board) => board);
    mock.script("replay", new Error("invalid record: bad seed"));
    mock.script("version", () => Promise.resolve("bg-wasm 0.1.0"));
    await expect(mock.applyPlay(OPENING, "white", PLAY)).resolves.toBe(OPENING);
    await expect(mock.applyPlay(OPENING, "white", "8/5 6/5")).resolves.toBe(OPENING);
    await expect(mock.replay(RECORD)).rejects.toThrow("invalid record: bad seed");
    await expect(mock.version()).resolves.toBe("bg-wasm 0.1.0");
  });

  it("rejects with a clear message when nothing is scripted", async () => {
    const mock = new MockEngine();
    await expect(mock.cubeAction(OPENING, "white", MONEY, "club")).rejects.toMatchObject({
      name: "EngineError",
      method: "cubeAction",
      message: "MockEngine: no scripted response for cubeAction",
    });
  });

  it("reset() clears scripts, fallbacks and calls; terminate() is recorded", async () => {
    const mock = new MockEngine();
    mock.always("version", "v");
    await mock.version();
    mock.reset();
    expect(mock.calls).toEqual([]);
    await expect(mock.version()).rejects.toThrow(/no scripted response/);
    mock.terminate();
    expect(mock.terminated).toBe(true);
  });
});
