/**
 * The `Origin` check of the WebSocket upgrade (server.ts). A browser sends
 * the page's origin with every handshake and attaches the seat cookie to
 * it; `SameSite=Lax` stops cross-*site* pages, but a page on a sibling
 * subdomain of the same registrable domain is same-site and would get the
 * cookie too. So a handshake that carries an `Origin` must carry one on the
 * allowlist (`ALLOWED_ORIGINS`, env.ts — the site's origin in production,
 * `http://localhost:3000` by default in development) or it is refused with
 * 403 before the upgrade; no wildcard, the scheme, host and port must all
 * match. A handshake without `Origin` is not a browser's: it is let through
 * only where the policy says so (outside production — tests, scripts), on
 * the strength of the seat cookie.
 */

export interface OriginPolicy {
  /** Origins as `scheme://host[:port]`, already normalised (`normalizeOrigin`). */
  readonly allowed: readonly string[];
  /** Accept a handshake that carries no `Origin` at all (non-browser clients; development only). */
  readonly allowMissing: boolean;
}

/** `scheme://host[:port]` of an http(s) origin, or `null` when `value` is not one (including the literal `"null"`). */
export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return url.origin;
}

/** Whether an upgrade carrying `header` as its `Origin` (or none) may proceed under `policy`. */
export function isOriginAllowed(header: string | undefined, policy: OriginPolicy): boolean {
  if (header === undefined) {
    return policy.allowMissing;
  }
  const origin = normalizeOrigin(header);
  return origin !== null && policy.allowed.includes(origin);
}
