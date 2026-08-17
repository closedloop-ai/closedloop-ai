import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // Use React's automatic JSX runtime so `.tsx` component tests compile without
  // a `React` global in scope (the sign-in/up embeds are function components).
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "server-only": path.resolve(
        __dirname,
        "../../apps/app/vitest-mocks/server-only.ts"
      ),
    },
  },
});
