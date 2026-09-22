#!/usr/bin/env node
// Bundles the realtime process (src/realtime/main.ts) into dist/realtime.js
// with esbuild (plan Task 5): one ESM file for Node 22, `@/` paths resolved
// from tsconfig.json, a source map beside it, and dist/package.json with
// `type: module` because web/package.json declares none (the image copies
// that file, so a `.js` bundle would otherwise be read as CommonJS).
//
// What stays outside the bundle is what the image already ships for the app
// (`@prisma/client` and the generated `.prisma/client`, resolved from
// web/node_modules) plus `ws` (copied into the image by the Dockerfile) and
// `bg-wasm`, which src/engine/node.ts loads from node_modules/bg-wasm at
// runtime by file URL. zod and the app's own modules are bundled.
// dist/realtime.meta.json is esbuild's metafile (tests/realtime/build.test.ts
// checks it; `pnpm exec esbuild --analyze` reads it).
//
// Run from anywhere: `pnpm --filter web realtime:build`; start the result
// with `pnpm --filter web realtime:start` (DATABASE_URL and SEAT_SECRET set).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(webDir, "dist");

/** Installed at runtime, never inlined. */
const EXTERNALS = ["bg-wasm", "@prisma/client", ".prisma/client", "ws"];

// esbuild's ESM output turns a runtime `require` inside bundled CommonJS
// into a shim that throws; a real `require` bound to this file keeps such
// a call working.
const REQUIRE_SHIM = 'import { createRequire as __bgCreateRequire } from "node:module";\nconst require = __bgCreateRequire(import.meta.url);\n';

async function main() {
  await mkdir(outDir, { recursive: true });
  const result = await build({
    absWorkingDir: webDir,
    entryPoints: [join(webDir, "src", "realtime", "main.ts")],
    outfile: join(outDir, "realtime.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    sourcemap: true,
    external: EXTERNALS,
    tsconfig: join(webDir, "tsconfig.json"),
    banner: { js: REQUIRE_SHIM },
    metafile: true,
    logLevel: "warning",
  });
  await writeFile(join(outDir, "package.json"), `${JSON.stringify({ type: "module" }, null, 2)}\n`);
  await writeFile(join(outDir, "realtime.meta.json"), JSON.stringify(result.metafile));
  const bytes = Object.entries(result.metafile.outputs).find(([path]) => path.endsWith("realtime.js"))?.[1].bytes ?? 0;
  process.stdout.write(`realtime bundle: dist/realtime.js (${String(Math.round(bytes / 1024))} KiB), externals: ${EXTERNALS.join(", ")}\n`);
}

main().catch((error) => {
  process.stderr.write(`realtime bundle failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
