import { defineConfig } from "vitest/config";

/** Native smoke tests are invoked only by `npm run test:native` on Windows. */
export default defineConfig({
  test: {
    exclude: ["test/**/*.windows.test.ts"],
  },
});
