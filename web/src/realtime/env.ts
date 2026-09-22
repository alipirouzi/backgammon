/**
 * The realtime process's environment, checked once at start so a
 * misconfigured container fails fast with one message naming everything
 * that is missing (plan Global Constraints: `SEAT_SECRET` and `DATABASE_URL`
 * are required). `ALLOWED_ORIGINS` is the comma-separated list of browser
 * origins (`scheme://host[:port]`) allowed to open a socket (origin.ts):
 * required under `NODE_ENV=production`, `http://localhost:3000` by default
 * elsewhere. Outside production a handshake without `Origin` (a script, the
 * tests) is allowed too. `SEAT_SECRET` is reserved for signed seat tokens;
 * the current seat cookies are verified against per-seat hashes (auth.ts),
 * so only its presence is checked here and its value is never logged.
 */

import { normalizeOrigin } from "./origin";

export const DEFAULT_PORT = 4000;
export const DEFAULT_HOST = "0.0.0.0";
/** `ALLOWED_ORIGINS` outside production when the variable is not set. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = ["http://localhost:3000"];

const REQUIRED_VARS = ["DATABASE_URL", "SEAT_SECRET"] as const;

export type EnvSource = { readonly [key: string]: string | undefined };

export interface RealtimeEnv {
  databaseUrl: string;
  seatSecret: string;
  /** Normalised `scheme://host[:port]` origins, in the order given. */
  allowedOrigins: readonly string[];
  /** `NODE_ENV` is not `production`: a handshake without `Origin` may open a socket. */
  allowMissingOrigin: boolean;
  port: number;
  host: string;
}

/** The environment cannot start the process; the message names the variables, never their values. */
export class RealtimeEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RealtimeEnvError";
  }
}

const isBlank = (value: string | undefined): value is undefined => value === undefined || value.trim().length === 0;

function parsePort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const port = /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RealtimeEnvError(`PORT must be an integer between 1 and 65535, got ${JSON.stringify(raw)}`);
  }
  return port;
}

/** One entry of `ALLOWED_ORIGINS` as `scheme://host[:port]`: an http(s) URL with nothing but scheme and host, or a `RealtimeEnvError` naming the variable. */
function parseOrigin(entry: string): string {
  const origin = normalizeOrigin(entry);
  const url = origin === null ? null : new URL(entry);
  const bare = url !== null && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "";
  if (origin === null || !bare) {
    throw new RealtimeEnvError(`ALLOWED_ORIGINS must list http(s) origins without a path, like https://backgammon.example, got ${JSON.stringify(entry)}`);
  }
  return origin;
}

/** The comma-separated `ALLOWED_ORIGINS`, blank entries dropped; `[]` when the variable is unset or blank. */
function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(parseOrigin);
}

/** Reads and validates the variables the realtime process needs; throws `RealtimeEnvError` naming what is wrong. */
export function parseRealtimeEnv(env: EnvSource = process.env): RealtimeEnv {
  const production = env.NODE_ENV === "production";
  const listed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const missing: string[] = REQUIRED_VARS.filter((name) => isBlank(env[name]));
  if (production && listed.length === 0) {
    missing.push("ALLOWED_ORIGINS");
  }
  const { DATABASE_URL: databaseUrl, SEAT_SECRET: seatSecret, HOST: host } = env;
  if (missing.length > 0 || databaseUrl === undefined || seatSecret === undefined) {
    throw new RealtimeEnvError(`missing required environment variable(s): ${missing.join(", ")}`);
  }
  return {
    databaseUrl,
    seatSecret,
    allowedOrigins: listed.length > 0 || production ? listed : DEFAULT_ALLOWED_ORIGINS,
    allowMissingOrigin: !production,
    port: parsePort(env.PORT),
    host: isBlank(host) ? DEFAULT_HOST : host,
  };
}
