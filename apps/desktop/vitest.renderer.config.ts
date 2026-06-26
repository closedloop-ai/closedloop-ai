import path from "node:path";
import { defineConfig } from "vitest/config";

// `@repo/shared-platform/*` resolves to `dist/` via package exports, but
// `pnpm test:renderer` doesn't build deps first — so point the subpaths the
// renderer uses at source (mirrors apps/app/vitest-shared-aliases.ts). Without
// this, a fresh checkout fails to resolve these imports.
const sharedPlatformSrc = path.resolve("../../packages/shared-platform/src");

// Renderer (React/jsdom) tests. Main-process tests stay on node:test via
// `tsx --test` (see the "test" script); this config covers the renderer
// __tests__ directories only. No @vitejs/plugin-react needed — vitest's
// esbuild handles TSX with the automatic JSX runtime (same setup as
// packages/navigation).
export default defineConfig({
  // The nearest tsconfig.json is the main-process one (no jsx setting), so
  // esbuild would fall back to the classic runtime; the renderer uses the
  // automatic runtime (tsconfig.renderer.json jsx: react-jsx).
  esbuild: {
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve("src/renderer"),
      "@closedloop-ai/design-system": path.resolve(
        "../../packages/design-system"
      ),
      "@repo/api": path.resolve("../../packages/api"),
      "@repo/app": path.resolve("../../packages/app"),
      "@repo/design-system": path.resolve("../../packages/design-system"),
      "@repo/shared-platform/gateway-dispatch": path.join(
        sharedPlatformSrc,
        "gateway-dispatch.ts"
      ),
      "@repo/shared-platform/gateway-fetch-shim": path.join(
        sharedPlatformSrc,
        "gateway-fetch-shim.ts"
      ),
      "@repo/shared-platform/relay-request-model": path.join(
        sharedPlatformSrc,
        "relay-request-model.ts"
      ),
      "@repo/shared-platform/routing-store": path.join(
        sharedPlatformSrc,
        "routing-store.ts"
      ),
      "@repo/shared-platform/types": path.join(sharedPlatformSrc, "types.ts"),
    },
  },
  test: {
    // globals also enables @testing-library/react auto-cleanup between tests.
    globals: true,
    environment: "jsdom",
    include: ["src/renderer/**/__tests__/**/*.test.{ts,tsx}"],
  },
});
