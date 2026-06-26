import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function stripCrossorigin(): Plugin {
  return {
    name: "strip-crossorigin",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return html.replace(/\s+crossorigin(=["'][^"']*["'])?/g, "");
      },
    },
  };
}

export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [tailwindcss(), react(), stripCrossorigin()],
  resolve: {
    alias: {
      "@": path.resolve("src/renderer"),
      "@repo/api": path.resolve("../../packages/api"),
      // packages/app uses self-referencing `@repo/app/<feature>/…` imports for
      // its cross-slice convention. The package has no `exports` field, so
      // Node-style self-resolution fails inside the package and Rollup silently
      // externalizes the bare specifier — which then throws at runtime when the
      // chunk loads. Alias to the package source so those imports bundle.
      "@repo/app": path.resolve("../../packages/app"),
    },
  },
  build: {
    outDir: path.resolve("dist/renderer"),
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: path.resolve("src/renderer/design-system/index.html"),
      onLog(level, log) {
        if (
          level === "warn" &&
          log.code === "MODULE_LEVEL_DIRECTIVE" &&
          log.message.includes("use client")
        ) {
          return;
        }
      },
      output: {
        manualChunks(id) {
          if (
            id.includes("recharts") ||
            id.includes("d3-") ||
            id.includes("d3/")
          ) {
            return "vendor-charts";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (id.includes("radix-ui") || id.includes("@radix-ui")) {
            return "vendor-radix";
          }
          if (id.includes("@closedloop-ai/design-system")) {
            return "vendor-ds";
          }
        },
      },
    },
  },
});
