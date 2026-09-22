/**
 * The per-socket limits of the realtime server (plan "Domain conventions":
 * Protocol/Validation): frames over 8 KiB close the socket with 1009 (the
 * `ws` server enforces `maxPayload` itself), and more than 20 messages in a
 * sliding 10 s window are refused with `rejected rateLimited`. The window
 * counts every frame, parseable or not — a client that floods garbage is
 * throttled the same as one that floods actions. One limiter per socket,
 * dropped with the socket, so there is no shared table to bound.
 */

/** Largest text frame accepted, in bytes. */
export const MAX_FRAME_BYTES = 8 * 1024;
/** Close code for a frame over `MAX_FRAME_BYTES` (RFC 6455 "message too big"). */
export const FRAME_TOO_LARGE_CLOSE_CODE = 1009;

/** Messages allowed per socket within `RATE_WINDOW_MS`. */
export const RATE_LIMIT = 20;
export const RATE_WINDOW_MS = 10_000;

export interface SocketLimiter {
  /** Records one frame and says whether it is within the limit. */
  hit(): boolean;
}

export interface SocketLimiterOptions {
  limit?: number;
  windowMs?: number;
  /** Clock in milliseconds (injectable for tests). */
  now?: () => number;
}

/** A sliding-window counter for one socket. */
export function createSocketLimiter({ limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS, now = Date.now }: SocketLimiterOptions = {}): SocketLimiter {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`socket rate limit must be a positive integer, got ${String(limit)}`);
  }
  if (!(windowMs > 0)) {
    throw new RangeError(`socket rate window must be positive, got ${String(windowMs)}`);
  }
  /** Timestamps of the frames still inside the window, oldest first. */
  let stamps: readonly number[] = [];
  return {
    hit() {
      const t = now();
      const horizon = t - windowMs;
      const recent = stamps.filter((stamp) => stamp > horizon);
      if (recent.length >= limit) {
        stamps = recent;
        return false;
      }
      stamps = [...recent, t];
      return true;
    },
  };
}
