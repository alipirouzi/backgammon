import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirror tsconfig's `@/*` → `src/*` so app code can import "@/engine/…".
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: { provider: "v8", reporter: ["text", "lcov"], include: ["src/**"] },
  },
});
