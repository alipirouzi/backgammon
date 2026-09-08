/**
 * Node-side loader for `bg-wasm` (no Web Worker): for route handlers and
 * tests. Loading follows `web/tests/engine-parity.test.ts`: the bundler
 * target's `bg_wasm.js` imports `bg_wasm_bg.wasm` as an ES module, which
 * Node handles natively; when that fails (or `BG_WASM_LOADER=manual` is
 * set) the glue module is wired by hand with `WebAssembly.instantiate`,
 * `__wbg_set_wasm` and `__wbindgen_start`, exactly as `bg_wasm.js` does.
 *
 * Server-only (`node:fs`, `node:module`): never import from browser code.
 * The package is located with `require.resolve("bg-wasm")` and imported by
 * file URL, so a bundler will not inline it; the standalone Next output must
 * therefore ship `node_modules/bg-wasm` (its `.wasm` included) itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
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

/** `engine/bg-wasm/pkg` as resolved from this package, or `null` when not built. */
export function locateBgWasmPkg(): string | null {
  try {
    const main = createRequire(import.meta.url).resolve("bg-wasm");
    return existsSync(main) ? dirname(main) : null;
  } catch {
    return null;
  }
}

async function loadManually(pkgDir: string): Promise<RawBgWasm> {
  const glue = (await import(pathToFileURL(join(pkgDir, "bg_wasm_bg.js")).href)) as Glue;
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
      const mod: unknown = await import(pathToFileURL(join(pkgDir, "bg_wasm.js")).href);
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
