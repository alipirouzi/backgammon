/**
 * `POST /api/games` — a finished bot game posted from the browser (plan:
 * record persistence API; spec §5.5, §8). Body: `{ record, seats }` with
 * `seats.white = { kind: "guest", name }` and `seats.black = { kind: "bot",
 * level }`. The service replays the record with the engine and stores it;
 * this handler only shapes the HTTP side: 201 `{ id }`, 400 `{ error }` for a
 * malformed or unfinished record, 413 for an oversized body, 429 past the
 * per-address limit, 500 with a generic message (the detail is logged, never
 * sent) for a database or engine failure.
 *
 * No idempotency on the server: the browser remembers what it posted
 * (`web/src/game/persist.ts`); posting the same record twice stores two games.
 */

import { GameNotFinished, RecordInvalid, verifyAndStore } from "@/server/games";
import { clientKey, createRateLimiter } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/** Posts allowed per address per minute (plan Task 10). */
export const RATE_LIMIT_PER_MINUTE = 30;
/** A record is a few tens of kilobytes; this refuses abuse, not games. Counted in bytes as received, not characters. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const limiter = createRateLimiter({ limit: RATE_LIMIT_PER_MINUTE, windowMs: 60_000 });

const NO_STORE = { "Cache-Control": "no-store" } as const;

const json = (body: unknown, status: number, headers: HeadersInit = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

const error = (message: string, status: number, headers: HeadersInit = {}): Response => json({ error: message }, status, headers);

interface Payload {
  record: unknown;
  seats: unknown;
}

function payloadOf(value: unknown): Payload | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const { record, seats } = value as { record?: unknown; seats?: unknown };
  return record === undefined || seats === undefined ? null : { record, seats };
}

/**
 * The body as text, read chunk by chunk and abandoned the moment its byte
 * count passes `maxBytes` — nothing larger than the cap is ever held. `null`
 * when the body was too large; a request without a body reads as `""`.
 */
async function readBodyWithin(request: Request, maxBytes: number): Promise<string | null> {
  if (request.body === null) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const tooLarge = (): Response => error(`the request body must be at most ${String(MAX_BODY_BYTES)} bytes`, 413);

export async function POST(request: Request): Promise<Response> {
  const decision = limiter.hit(clientKey(request.headers));
  if (!decision.allowed) {
    const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    return error("too many games posted from this address; try again in a minute", 429, { "Retry-After": String(seconds) });
  }

  // A declared size over the cap is refused before a byte is read; the cap is
  // enforced on the bytes actually received either way (a chunked body
  // declares nothing, and a declaration is only a claim).
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return tooLarge();
  }
  let text: string | null;
  try {
    text = await readBodyWithin(request, MAX_BODY_BYTES);
  } catch {
    return error("the request body could not be read", 400);
  }
  if (text === null) {
    return tooLarge();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return error("the request body is not valid JSON", 400);
  }
  const payload = payloadOf(parsed);
  if (payload === null) {
    return error("the request body must be an object with `record` and `seats`", 400);
  }

  try {
    const { id } = await verifyAndStore(payload.record, payload.seats);
    return json({ id }, 201);
  } catch (failure) {
    if (failure instanceof RecordInvalid || failure instanceof GameNotFinished) {
      return error(failure.message, 400);
    }
    // Spec §8: the event is logged; the client learns only that saving failed.
    console.error("POST /api/games failed:", failure instanceof Error ? failure.message : String(failure));
    return error("the game could not be saved", 500);
  }
}
