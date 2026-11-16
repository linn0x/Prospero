import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: false },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
    },
    build: {
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replaceAll("\\", "/");
            if (
              normalized.includes("/node_modules/katex/") ||
              normalized.includes("/node_modules/rehype-katex/") ||
              normalized.includes("/node_modules/remark-math/") ||
              normalized.includes("/node_modules/micromark-extension-math/") ||
              normalized.includes("/node_modules/mdast-util-math/")
            ) {
              return "markdown-math";
            }
            if (
              normalized.includes("/node_modules/highlight.js/") ||
              normalized.includes("/node_modules/lowlight/") ||
              normalized.includes("/node_modules/rehype-highlight/")
            ) {
              return "markdown-highlight";
            }
            if (
              normalized.includes("/packages/protocol/") ||
              normalized.includes("/node_modules/zod/") ||
              normalized.includes("/node_modules/tweetnacl/")
            ) {
              return "protocol";
            }
            if (
              normalized.includes("/node_modules/@base-ui/") ||
              normalized.includes("/node_modules/@floating-ui/")
            ) {
              return "ui-primitives";
            }
            return undefined;
          },
        },
      },
    },
  },
});
