import { defineConfig } from "vitest/config";

export default defineConfig({
  // The package tsconfig extends the Next config (`jsx: preserve`), so esbuild
  // needs the automatic runtime spelled out for test JSX to transform.
  esbuild: { jsx: "automatic" },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["../typescript-config/vitest-localstorage-setup"],
  },
});
