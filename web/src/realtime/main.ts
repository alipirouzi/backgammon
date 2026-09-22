/**
 * Entry point of the realtime process (plan Task 4; `node web/realtime.js`
 * in the image, Task 5). Wires the parts together and nothing else: the
 * environment (env.ts) is validated before anything connects
 * (`ALLOWED_ORIGINS` becomes the socket's Origin policy), the wasm engine is loaded
 * once, the Prisma client (`@/server/db`) backs the sessions registry
 * (sessions.ts), the seat check (auth.ts) and `/healthz`,
 * and `SIGTERM`/`SIGINT` drain the server (sockets closed with 1001, sweep
 * stopped, client disconnected) before the process exits. Any failure to
 * start, or a drain that does not finish within `SHUTDOWN_TIMEOUT_MS`,
 * exits non-zero so the orchestrator restarts the container.
 */

import { loadEngineNode } from "@/engine/node";
import { disconnectDb, getDb } from "@/server/db";

import { verifySeat } from "./auth";
import { parseRealtimeEnv } from "./env";
import { log } from "./log";
import { createRealtimeServer } from "./server";
import { SessionRegistry } from "./sessions";

/** How long a drain may take before the process exits anyway. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

type Signal = "SIGTERM" | "SIGINT";
const SIGNALS: readonly Signal[] = ["SIGTERM", "SIGINT"];

async function main(): Promise<void> {
  const env = parseRealtimeEnv();
  const db = getDb();
  const engine = await loadEngineNode();
  const registry = new SessionRegistry({ db, engine, logger: log.child({ component: "sessions" }) });
  const server = createRealtimeServer({
    registry,
    verifySeat: (gameId, seat, secret) => verifySeat(db, gameId, seat, secret),
    healthCheck: async () => {
      await db.$queryRaw`SELECT 1`;
    },
    origins: { allowed: env.allowedOrigins, allowMissing: env.allowMissingOrigin },
    log: log.child({ component: "server" }),
  });

  let draining = false;
  const drain = (signal: Signal): void => {
    if (draining) {
      return;
    }
    draining = true;
    log.info("signal received, draining", { signal });
    const deadline = setTimeout(() => {
      log.error("shutdown did not finish in time", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    server
      .shutdown()
      .then(() => disconnectDb())
      .then(
        () => {
          clearTimeout(deadline);
          process.exit(0);
        },
        (error: unknown) => {
          log.error("shutdown failed", { error });
          process.exit(1);
        },
      );
  };
  for (const signal of SIGNALS) {
    process.on(signal, () => drain(signal));
  }

  registry.start();
  await server.listen(env.port, env.host);
  log.info("realtime process ready", { port: env.port, host: env.host });
}

main().catch((error: unknown) => {
  log.error("realtime process failed to start", { error });
  process.exit(1);
});
