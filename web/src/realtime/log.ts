/**
 * A tiny structured logger for the realtime process: one JSON object per
 * line on stdout (`{"at","level","msg",...fields}`), levels `debug` <
 * `info` < `warn` < `error`, the threshold from `LOG_LEVEL` (default
 * `info`). Errors passed as a field are flattened to `{ name, message }`
 * (plus `stack` at `debug`) so a line never carries an unserialisable
 * value. Never throws: a field that cannot be serialised is replaced by its
 * `String()`.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = { readonly [key: string]: unknown };

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Where lines go; `process.stdout` by default. */
  write?: (line: string) => void;
  /** Timestamp source (ISO 8601); `Date` by default. */
  now?: () => string;
  /** Fields added to every line. */
  fields?: LogFields;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export const isLogLevel = (value: unknown): value is LogLevel => typeof value === "string" && (LEVELS as readonly string[]).includes(value);

/** `LOG_LEVEL` when it names a level, else `info`. */
export function levelFromEnv(env: { readonly [key: string]: string | undefined } = process.env): LogLevel {
  const value = env.LOG_LEVEL;
  return isLogLevel(value) ? value : "info";
}

function plainError(error: Error, withStack: boolean): LogFields {
  const base = { name: error.name, message: error.message };
  return withStack && error.stack !== undefined ? { ...base, stack: error.stack } : base;
}

function serialise(entry: LogFields): string {
  try {
    return JSON.stringify(entry);
  } catch {
    const safe = Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));
    return JSON.stringify(safe);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = LEVELS.indexOf(options.level ?? "info");
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? (() => new Date().toISOString());
  const base = options.fields ?? {};

  const emit = (level: LogLevel, msg: string, fields: LogFields = {}): void => {
    if (LEVELS.indexOf(level) < threshold) {
      return;
    }
    const flattened = Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v instanceof Error ? plainError(v, threshold === 0) : v]),
    );
    write(serialise({ at: now(), level, msg, ...base, ...flattened }));
  };

  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (fields) => createLogger({ ...options, fields: { ...base, ...fields } }),
  };
}

/** The process-wide logger, levelled by `LOG_LEVEL`. */
export const log: Logger = createLogger({ level: levelFromEnv() });
