import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
    globals: true,
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        // ISS-9849 pins two guards that live inside `@liveblocks/react-tiptap`
        // itself (applied by `patches/@liveblocks__react-tiptap@3.18.5.patch`).
        // A node_modules package is externalized by default and loaded through
        // native ESM, so its OWN imports bypass the `vi.mock` registry and the
        // test would silently run against the real Liveblocks room hooks.
        // Inlining routes it through Vite so those mocks apply.
        inline: ["@liveblocks/react-tiptap"],
      },
    },
  },
  resolve: {
    alias: {
      // `@repo/loops-api` and `@repo/shared-platform` are source-consumed under
      // a `/src` root, so their specific aliases MUST precede the catch-all
      // `@repo` (Vite matches aliases in declaration order). Reachable
      // transitively via `@repo/api`'s type modules, which re-export from both.
      // `@repo/realtime-contract` is the same shape, imported by
      // `shared/room-utils.ts`.
      "@repo/cost": path.resolve(__dirname, "../cost/src"),
      // ISS-12503: source-consumed under `src/`, like the contract below.
      "@repo/document-schema": path.resolve(
        __dirname,
        "../document-schema/src"
      ),
      "@closedloop-ai/loops-api": path.resolve(__dirname, "../loops-api/src"),
      "@repo/loops-api": path.resolve(__dirname, "../loops-api/src"),
      "@repo/realtime-contract": path.resolve(
        __dirname,
        "../realtime-contract/src"
      ),
      "@closedloop-ai/shared-platform": path.resolve(
        __dirname,
        "../shared-platform/src"
      ),
      "@repo/shared-platform": path.resolve(
        __dirname,
        "../shared-platform/src"
      ),
      "@repo": path.resolve(__dirname, "../"),
      "server-only": path.resolve(
        __dirname,
        "../typescript-config/vitest-server-only-stub.ts"
      ),
    },
  },
});
