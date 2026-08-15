import { defineConfig } from "vitest/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Direct native smoke tests intentionally run only after node-gyp has built the
// addon on a real supported Windows architecture. They are kept out of the
// portable mock-loader suite so macOS/Linux remain fail-closed and green.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ["test/**/*.windows.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 20_000,
    hookTimeout: 15_000,
  },
});
