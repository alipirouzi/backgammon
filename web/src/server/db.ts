/**
 * The Prisma client, one per process (`globalThis` keeps it across Next's
 * dev-mode module reloads). `DATABASE_URL` is read only when the client is
 * first asked for, so importing this module — during `next build`'s route
 * collection or in tests that mock it — needs no database.
 *
 * Server-only. Route handlers, server components and `src/server/*` may
 * import it; client components must not (the `typeof window` guard below
 * turns such a mistake into a clear error at module evaluation rather than
 * a bundle full of `@prisma/client`).
 */

import { PrismaClient } from "@prisma/client";

if (typeof window !== "undefined") {
  throw new Error("src/server/db.ts is server-only and must not be imported by client components");
}

/** `DATABASE_URL` is not set: nothing can be stored or read. */
export class DatabaseNotConfigured extends Error {
  constructor() {
    super("DATABASE_URL is not set");
    this.name = "DatabaseNotConfigured";
  }
}

const globalForPrisma = globalThis as typeof globalThis & { __bgPrisma?: PrismaClient };

/** The process-wide client; throws `DatabaseNotConfigured` without `DATABASE_URL`. */
export function getDb(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    throw new DatabaseNotConfigured();
  }
  globalForPrisma.__bgPrisma ??= new PrismaClient({ log: ["warn", "error"] });
  return globalForPrisma.__bgPrisma;
}

/** Closes the client (tests and graceful shutdown); a no-op when none was created. */
export async function disconnectDb(): Promise<void> {
  const client = globalForPrisma.__bgPrisma;
  globalForPrisma.__bgPrisma = undefined;
  await client?.$disconnect();
}
