import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@repo": path.resolve(__dirname, "../"),
      "server-only": path.resolve(
        __dirname,
        "../../apps/app/vitest-mocks/server-only.ts"
      ),
    },
  },
});
