/**
 * Web Worker entry: loads `bg-wasm` (bundler target) and answers protocol
 * requests. Created by `client.ts` as
 * `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
 *
 * The wasm module is loaded with a dynamic import held as a promise so that
 * (a) the message listener is registered synchronously, before any message
 * can arrive, and (b) a failure to load the wasm surfaces as an `{ ok:
 * false }` reply to every request instead of a silently dead worker.
 */

import { isRes, type Req, type Res } from "./protocol";
import { asRawBgWasm, dispatch, wrapRawEngine, type EngineSync } from "./sync";

const enginePromise: Promise<EngineSync> = import("bg-wasm").then((mod) => wrapRawEngine(asRawBgWasm(mod)));

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const reply = (res: Res): void => {
  postMessage(res);
};

async function handle(req: Req): Promise<void> {
  try {
    const engine = await enginePromise;
    reply({ id: req.id, ok: true, result: dispatch(engine, req) });
  } catch (error) {
    reply({ id: req.id, ok: false, error: errorMessage(error) });
  }
}

addEventListener("message", (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== "object" || data === null || isRes(data)) {
    return;
  }
  const req = data as { id?: unknown; type?: unknown };
  if (typeof req.id !== "number" || typeof req.type !== "string") {
    return;
  }
  void handle(data as Req);
});
