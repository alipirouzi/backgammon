/**
 * UI-thread client for the engine worker. `createEngine()` returns an
 * `Engine` whose methods post one protocol request at a time to a Web
 * Worker (`worker.ts`) and resolve with the parsed result. `MockEngine`
 * implements the same interface with scripted responses for tests.
 *
 * Browser-only: the worker is spawned lazily on the first call, so the
 * module can be imported during server rendering as long as no method runs.
 */

import { isRes, type Req, type ReqBody, type ReqType, type ResultFor } from "./protocol";
import type {
  Board,
  ChosenPlay,
  CubeAnalysis,
  Dice,
  Level,
  MatchContext,
  MatchState,
  MoveAnalysis,
  Play,
  Player,
  Record as GameRecord,
} from "./types";

/** Default per-request timeout (plan, Task 1). */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Typed asynchronous engine, one method per protocol request. */
export interface Engine {
  legalPlays(board: Board, onRoll: Player, dice: Dice): Promise<Play[]>;
  applyPlay(board: Board, onRoll: Player, play: Play | string): Promise<Board>;
  choosePlay(
    board: Board,
    onRoll: Player,
    dice: Dice,
    matchCtx: MatchContext,
    level: Level,
    seed: number,
  ): Promise<ChosenPlay>;
  cubeAction(board: Board, onRoll: Player, matchCtx: MatchContext, level: Level): Promise<CubeAnalysis>;
  analyzePlay(
    board: Board,
    onRoll: Player,
    dice: Dice,
    matchCtx: MatchContext,
    played: string,
    seed: number,
  ): Promise<MoveAnalysis>;
  replay(record: GameRecord): Promise<MatchState>;
  version(): Promise<string>;
  /** Stops the worker; every pending or later call rejects with `EngineError`. */
  terminate(): void;
}

/** Names of the request-bearing methods (everything but `terminate`). */
export type EngineMethod = ReqType;

/** Why an engine call failed; `kind` lets the UI phrase it. */
export type EngineErrorKind = "engine" | "timeout" | "terminated" | "worker";

export class EngineError extends Error {
  readonly method: EngineMethod;
  readonly kind: EngineErrorKind;

  constructor(method: EngineMethod, kind: EngineErrorKind, message: string) {
    super(message);
    this.name = "EngineError";
    this.method = method;
    this.kind = kind;
  }
}

/** The subset of the DOM `Worker` the client relies on (a test double implements it). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface CreateEngineOptions {
  /** Per-request timeout in milliseconds; `DEFAULT_TIMEOUT_MS` if omitted. */
  timeoutMs?: number;
  /** Replaces the default `new Worker(...)`; tests inject a fake here. */
  workerFactory?: () => WorkerLike;
}

/**
 * The production worker. The `new Worker(new URL('./worker.ts',
 * import.meta.url), { type: 'module' })` expression must stay literal so the
 * bundler emits the worker chunk.
 */
function spawnWorker(): WorkerLike {
  if (typeof Worker === "undefined") {
    throw new Error("engine: Web Workers are not available in this environment (server rendering?)");
  }
  return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
}

interface Pending {
  id: number;
  method: EngineMethod;
  req: Req;
  resolve: (value: unknown) => void;
  reject: (error: EngineError) => void;
}

/**
 * Creates the worker-backed engine. Requests are strictly sequential: the
 * next one is posted only after the previous reply, timeout or failure.
 * The wasm call inside the worker is synchronous and cannot be cancelled, so
 * a timed-out request leaves the worker busy until it finishes; its late
 * reply is discarded and the queue moves on. A worker that fails outright
 * (`onerror`) is terminated and replaced by a fresh one on the next request.
 */
export function createEngine(options: CreateEngineOptions = {}): Engine {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const factory = options.workerFactory ?? spawnWorker;

  let worker: WorkerLike | null = null;
  let terminated = false;
  let nextId = 1;
  const queue: Pending[] = [];
  let inFlight: Pending | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const settle = (pending: Pending, outcome: { ok: true; result: unknown } | { ok: false; error: EngineError }): void => {
    if (inFlight !== pending) {
      return;
    }
    clearTimer();
    inFlight = null;
    if (outcome.ok) {
      pending.resolve(outcome.result);
    } else {
      pending.reject(outcome.error);
    }
    pump();
  };

  const onMessage = (event: MessageEvent): void => {
    const data: unknown = event.data;
    if (!isRes(data) || inFlight === null || data.id !== inFlight.id) {
      return; // stale reply for a timed-out request, or noise
    }
    if (data.ok) {
      settle(inFlight, { ok: true, result: data.result });
    } else {
      settle(inFlight, { ok: false, error: new EngineError(inFlight.method, "engine", data.error) });
    }
  };

  /**
   * The worker itself failed (its script or the wasm chunk did not load, or
   * it threw outside a request). It is unusable from here on, so it is
   * discarded before the in-flight request settles: `settle` pumps the
   * queue, and the next request must spawn a fresh worker rather than wait
   * a full timeout on the dead one.
   */
  const onError = (event: ErrorEvent): void => {
    const detail = event.message ? `: ${event.message}` : "";
    discardWorker();
    if (inFlight !== null) {
      settle(inFlight, {
        ok: false,
        error: new EngineError(inFlight.method, "worker", `engine worker failed${detail}`),
      });
    }
  };

  const discardWorker = (): void => {
    if (worker === null) {
      return;
    }
    const dead = worker;
    worker = null;
    dead.onmessage = null;
    dead.onerror = null;
    dead.terminate();
  };

  const ensureWorker = (): WorkerLike => {
    if (worker === null) {
      worker = factory();
      worker.onmessage = onMessage;
      worker.onerror = onError;
    }
    return worker;
  };

  const pump = (): void => {
    if (inFlight !== null || terminated) {
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      return;
    }
    inFlight = next;
    let target: WorkerLike;
    try {
      target = ensureWorker();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle(next, { ok: false, error: new EngineError(next.method, "worker", message) });
      return;
    }
    timer = setTimeout(() => {
      settle(next, {
        ok: false,
        error: new EngineError(
          next.method,
          "timeout",
          `engine: ${next.method} timed out after ${timeoutMs} ms; the engine worker is still busy or has stopped responding`,
        ),
      });
    }, timeoutMs);
    target.postMessage(next.req);
  };

  const request = <T extends ReqType>(body: ReqBody<T>): Promise<ResultFor<T>> =>
    new Promise<ResultFor<T>>((resolve, reject) => {
      const method = body.type as T;
      if (terminated) {
        reject(new EngineError(method, "terminated", `engine: ${method} called after terminate()`));
        return;
      }
      const id = nextId++;
      const req = { ...body, id } as Req;
      queue.push({ id, method, req, resolve: resolve as (value: unknown) => void, reject });
      pump();
    });

  const terminate = (): void => {
    if (terminated) {
      return;
    }
    terminated = true;
    clearTimer();
    const rejectAll = (pending: Pending): void => {
      pending.reject(new EngineError(pending.method, "terminated", `engine: ${pending.method} cancelled by terminate()`));
    };
    const current = inFlight;
    inFlight = null;
    if (current !== null) {
      rejectAll(current);
    }
    for (const pending of queue.splice(0)) {
      rejectAll(pending);
    }
    discardWorker();
  };

  return {
    legalPlays: (board, onRoll, dice) => request<"legalPlays">({ type: "legalPlays", board, onRoll, dice }),
    applyPlay: (board, onRoll, play) => request<"applyPlay">({ type: "applyPlay", board, onRoll, play }),
    choosePlay: (board, onRoll, dice, matchCtx, level, seed) =>
      request<"choosePlay">({ type: "choosePlay", board, onRoll, dice, matchCtx, level, seed }),
    cubeAction: (board, onRoll, matchCtx, level) =>
      request<"cubeAction">({ type: "cubeAction", board, onRoll, matchCtx, level }),
    analyzePlay: (board, onRoll, dice, matchCtx, played, seed) =>
      request<"analyzePlay">({ type: "analyzePlay", board, onRoll, dice, matchCtx, played, seed }),
    replay: (record) => request<"replay">({ type: "replay", record }),
    version: () => request<"version">({ type: "version" }),
    terminate,
  };
}

// ---------------------------------------------------------------------------
// MockEngine

/** Positional arguments of each `Engine` method. */
export type EngineArgs<M extends EngineMethod> = Parameters<Engine[M]>;

/** Resolved value of each `Engine` method. */
export type EngineResult<M extends EngineMethod> = Awaited<ReturnType<Engine[M]>>;

/**
 * A scripted response: the value itself, an `Error` (the call rejects with
 * it), or a function of the call's arguments returning either.
 */
export type MockResponse<M extends EngineMethod> =
  | EngineResult<M>
  | Error
  | ((...args: EngineArgs<M>) => EngineResult<M> | Error | Promise<EngineResult<M>>);

export interface MockCall {
  method: EngineMethod;
  args: unknown[];
}

const ENGINE_METHODS = [
  "legalPlays",
  "applyPlay",
  "choosePlay",
  "cubeAction",
  "analyzePlay",
  "replay",
  "version",
] as const satisfies readonly EngineMethod[];

/**
 * `Engine` double for component and store tests. Responses are scripted per
 * method: `script()` queues one-shot responses consumed FIFO; `always()`
 * sets a fallback used when the queue is empty. A call with neither rejects
 * with `MockEngine: no scripted response for <method>`. Every call is
 * appended to `calls`.
 *
 * ```ts
 * const engine = new MockEngine();
 * engine.script("legalPlays", [play]);                       // next call resolves [play]
 * engine.always("applyPlay", (board) => board);              // every call echoes the board
 * engine.script("replay", new Error("invalid record"));      // next call rejects
 * await store.roll();
 * expect(engine.calls.map((c) => c.method)).toEqual(["replay"]);
 * ```
 */
export class MockEngine implements Engine {
  readonly calls: MockCall[] = [];
  terminated = false;

  private readonly queues = new Map<EngineMethod, MockResponse<EngineMethod>[]>();
  private readonly fallbacks = new Map<EngineMethod, MockResponse<EngineMethod>>();

  constructor() {
    for (const method of ENGINE_METHODS) {
      this.queues.set(method, []);
    }
  }

  /** Queues one-shot responses for `method`, consumed in order. */
  script<M extends EngineMethod>(method: M, ...responses: MockResponse<M>[]): this {
    this.queues.get(method)?.push(...(responses as MockResponse<EngineMethod>[]));
    return this;
  }

  /** Response used whenever the queue for `method` is empty. */
  always<M extends EngineMethod>(method: M, response: MockResponse<M>): this {
    this.fallbacks.set(method, response as MockResponse<EngineMethod>);
    return this;
  }

  /** Calls made to `method`, in order. */
  callsTo<M extends EngineMethod>(method: M): EngineArgs<M>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args as EngineArgs<M>);
  }

  /** Forgets scripts, fallbacks and recorded calls. */
  reset(): void {
    this.calls.length = 0;
    this.fallbacks.clear();
    for (const queue of this.queues.values()) {
      queue.length = 0;
    }
    this.terminated = false;
  }

  legalPlays(...args: EngineArgs<"legalPlays">): Promise<Play[]> {
    return this.invoke("legalPlays", args);
  }

  applyPlay(...args: EngineArgs<"applyPlay">): Promise<Board> {
    return this.invoke("applyPlay", args);
  }

  choosePlay(...args: EngineArgs<"choosePlay">): Promise<ChosenPlay> {
    return this.invoke("choosePlay", args);
  }

  cubeAction(...args: EngineArgs<"cubeAction">): Promise<CubeAnalysis> {
    return this.invoke("cubeAction", args);
  }

  analyzePlay(...args: EngineArgs<"analyzePlay">): Promise<MoveAnalysis> {
    return this.invoke("analyzePlay", args);
  }

  replay(...args: EngineArgs<"replay">): Promise<MatchState> {
    return this.invoke("replay", args);
  }

  version(...args: EngineArgs<"version">): Promise<string> {
    return this.invoke("version", args);
  }

  terminate(): void {
    this.terminated = true;
  }

  private async invoke<M extends EngineMethod>(method: M, args: EngineArgs<M>): Promise<EngineResult<M>> {
    this.calls.push({ method, args: [...args] });
    const queued = this.queues.get(method)?.shift();
    const response = (queued ?? this.fallbacks.get(method)) as MockResponse<M> | undefined;
    if (response === undefined) {
      throw new EngineError(method, "engine", `MockEngine: no scripted response for ${method}`);
    }
    const value =
      typeof response === "function"
        ? await (response as (...a: EngineArgs<M>) => EngineResult<M> | Error | Promise<EngineResult<M>>)(...args)
        : response;
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
}
