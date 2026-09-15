/**
 * Node-side loader for `bg-wasm` (no Web Worker): for route handlers and
 * tests. Loading follows `web/tests/engine-parity.test.ts`: the bundler
 * target's `bg_wasm.js` imports `bg_wasm_bg.wasm` as an ES module, which
 * Node handles natively; when that fails (or `BG_WASM_LOADER=manual` is
 * set) the glue module is wired by hand with `WebAssembly.instantiate`,
 * `__wbg_set_wasm` and `__wbindgen_start`, exactly as `bg_wasm.js` does.
 *
 * Server-only (`node:fs`): never import from browser code. The package is
 * located on disk — `BG_WASM_DIR` when set, else the nearest
 * `node_modules/bg-wasm` above the working directory — and imported by file
 * URL with the bundler told to leave the import alone (`turbopackIgnore`,
 * `webpackIgnore`), so nothing here is inlined at build time: Turbopack would
 * otherwise rewrite `createRequire(import.meta.url).resolve("bg-wasm")` to a
 * module id and a computed `import()` to a "too dynamic" stub, which is what
 * the first production build of `/api/games` did. The standalone Next output
 * therefore ships `web/node_modules/bg-wasm` (its `.wasm` included) itself
 * (Dockerfile); Next's server chdirs to `web/`, as `next dev` and Vitest run
 * from there too.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { asRawBgWasm, wrapRawEngine, type EngineSync, type RawBgWasm } from "./sync";

export type { EngineSync } from "./sync";

export type NodeLoader = "esm" | "manual";

export interface LoadedEngineNode {
  engine: EngineSync;
  /** Which loading path succeeded. */
  loader: NodeLoader;
  /** Directory of the built `bg-wasm` package. */
  pkgDir: string;
}

type Glue = WebAssembly.ModuleImports & {
  __wbg_set_wasm(exports: WebAssembly.Exports): void;
};

/** The file every built package has; its presence is the test for "built". */
const PKG_MAIN = "bg_wasm.js";

/**
 * The built `bg-wasm` package (`engine/bg-wasm/pkg`): `BG_WASM_DIR` when set,
 * else the first `node_modules/bg-wasm` found walking up from the working
 * directory (the workspace symlink in `web/node_modules`, or the copy the
 * image ships). `null` when not built.
 */
export function locateBgWasmPkg(): string | null {
  const override = process.env.BG_WASM_DIR;
  if (override) {
    return existsSync(join(override, PKG_MAIN)) ? override : null;
  }
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, "node_modules", "bg-wasm");
    if (existsSync(join(candidate, PKG_MAIN))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** A dynamic import the bundlers leave for Node to resolve at runtime. */
const importFile = (path: string): Promise<unknown> =>
  import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ pathToFileURL(path).href);

async function loadManually(pkgDir: string): Promise<RawBgWasm> {
  const glue = (await importFile(join(pkgDir, "bg_wasm_bg.js"))) as Glue;
  const bytes = readFileSync(join(pkgDir, "bg_wasm_bg.wasm"));
  const { instance } = await WebAssembly.instantiate(bytes, { "./bg_wasm_bg.js": glue });
  glue.__wbg_set_wasm(instance.exports);
  const start = instance.exports.__wbindgen_start;
  if (typeof start === "function") {
    start();
  }
  return asRawBgWasm(glue);
}

let cached: Promise<LoadedEngineNode> | null = null;

async function load(): Promise<LoadedEngineNode> {
  const pkgDir = locateBgWasmPkg();
  if (pkgDir === null) {
    throw new Error(
      "bg-wasm is not built: run `wasm-pack build engine/bg-wasm --target bundler --release --out-dir pkg --out-name bg_wasm` from the repository root, then `pnpm install`",
    );
  }
  if (process.env.BG_WASM_LOADER !== "manual") {
    try {
      const mod: unknown = await importFile(join(pkgDir, PKG_MAIN));
      return { engine: wrapRawEngine(asRawBgWasm(mod)), loader: "esm", pkgDir };
    } catch {
      // Fall through to the documented manual loader.
    }
  }
  return { engine: wrapRawEngine(await loadManually(pkgDir)), loader: "manual", pkgDir };
}

/** Loads the engine with details of how it was loaded; memoised per process. */
export function loadEngineNodeDetailed(): Promise<LoadedEngineNode> {
  cached ??= load().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

/** The typed synchronous engine, loaded once per process. */
export async function loadEngineNode(): Promise<EngineSync> {
  return (await loadEngineNodeDetailed()).engine;
}
