// The realtime bundle (plan Task 5): `scripts/build-realtime.mjs` must
// produce web/dist/realtime.js as an ESM bundle Node 22 can run from the
// image (`node web/dist/realtime.js`), with the installed dependencies the
// image ships (`ws`, `@prisma/client`, the generated client) left external,
// zod bundled, no wasm bytes inlined (the engine is loaded from
// node_modules/bg-wasm at runtime), a source map, and a `dist/package.json`
// declaring `type: module` (web/package.json has none, so the `.js` bundle
// would otherwise be parsed as CommonJS). The last test runs the bundle
// under Node without the required variables: it must fail fast with the
// env error, which proves the bundle loads (`ws`, Prisma) outside of Vitest.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

const webDir = fileURLToPath(new URL("../..", import.meta.url));
const distDir = join(webDir, "dist");
const bundle = join(distDir, "realtime.js");

interface Metafile {
  inputs: { [path: string]: unknown };
  outputs: { [path: string]: { bytes: number; entryPoint?: string } };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

/** `process.env` without `names` (omitted, not set to undefined), as a production process sees it — where `ALLOWED_ORIGINS` has no default. */
function productionEnvWithout(...names: string[]): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(process.env).filter(([key]) => !names.includes(key)));
  return { ...kept, NODE_ENV: "production" };
}

describe("realtime bundle (scripts/build-realtime.mjs)", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build-realtime.mjs"], { cwd: webDir, stdio: "pipe" });
  }, 60_000);

  it("writes the bundle, its source map, the metafile and an ESM package.json into dist/", () => {
    expect(existsSync(bundle)).toBe(true);
    expect(existsSync(`${bundle}.map`)).toBe(true);
    expect(existsSync(join(distDir, "realtime.meta.json"))).toBe(true);
    expect(readJson<{ type?: string }>(join(distDir, "package.json"))).toEqual({ type: "module" });
    expect(readFileSync(bundle, "utf8")).toMatch(/\/\/# sourceMappingURL=realtime\.js\.map\s*$/);
  });

  it("leaves ws, @prisma/client and the generated client external and bundles zod", () => {
    const meta = readJson<Metafile>(join(distDir, "realtime.meta.json"));
    const inputs = Object.keys(meta.inputs);
    expect(inputs.some((p) => /node_modules\/zod\//.test(p))).toBe(true);
    expect(inputs.filter((p) => /node_modules\/(ws|@prisma\/client|\.prisma)\//.test(p))).toEqual([]);
    expect(inputs.filter((p) => /bg-wasm|\.wasm$/.test(p))).toEqual([]);
    expect(inputs.some((p) => p.endsWith("src/realtime/main.ts"))).toBe(true);

    const text = readFileSync(bundle, "utf8");
    expect(text).toMatch(/from\s*"ws"/);
    expect(text).toMatch(/from\s*"@prisma\/client"/);
  });

  it("runs under Node and fails fast, on stdout as JSON, when DATABASE_URL, SEAT_SECRET and ALLOWED_ORIGINS are missing in production", async () => {
    const run = promisify(execFile);
    const result = await run(process.execPath, [bundle], {
      cwd: webDir,
      env: productionEnvWithout("DATABASE_URL", "SEAT_SECRET", "ALLOWED_ORIGINS"),
    }).then(
      () => {
        throw new Error("the bundle started without its environment");
      },
      (error: unknown) => error as { code?: number; stdout: string; stderr: string },
    );
    expect(result.code).toBe(1);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { level: string; msg: string; error?: { name: string; message: string } });
    const failure = lines.find((l) => l.msg === "realtime process failed to start");
    expect(failure?.level).toBe("error");
    expect(failure?.error?.name).toBe("RealtimeEnvError");
    expect(failure?.error?.message).toContain("DATABASE_URL");
    expect(failure?.error?.message).toContain("SEAT_SECRET");
    expect(failure?.error?.message).toContain("ALLOWED_ORIGINS");
  }, 30_000);
});
