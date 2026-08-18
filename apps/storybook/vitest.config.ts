import path from "node:path";
import { defineConfig } from "vitest/config";
import { storybookModuleAliases } from "./.storybook/module-aliases";

const repoRoot = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  // This app's tsconfig extends the Next.js preset, which sets
  // `jsx: "preserve"` for the Next compiler. Vitest's esbuild transform honors
  // that and would ship untransformed JSX to jsdom, so the runtime is pinned
  // here instead of weakening the app's tsconfig.
  esbuild: {
    jsx: "automatic",
  },
  // `.storybook/preview.tsx` imports two stylesheets. jsdom does no layout, so
  // nothing here can assert on styling and running PostCSS would be pure cost.
  // It is also load-bearing: this app's `postcss.config.mjs` registers
  // `tailwindcss` as a direct PostCSS plugin, which Tailwind v4 rejects, and
  // unlike its siblings this app neither depends on `@tailwindcss/postcss` nor
  // re-exports the design-system config. Storybook's webpack pipeline evidently
  // never exercises that path; Vite's would.
  css: {
    postcss: {
      plugins: [],
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      // Vite matches aliases in DECLARATION ORDER, so every specific entry must
      // precede the `@repo` catch-all. That ordering contract is the same one
      // `packages/app/vitest.config.ts` documents.
      //
      // The shared map (also used by `.storybook/main.ts`'s webpack resolver)
      // carries the deep subpath aliases — `@closedloop-ai/telemetry-contract/*`
      // and `@repo/shared-platform/*` — that stories reach transitively. The
      // desktop renderer's session-detail-view story is the proof: it pulls in
      // `@closedloop-ai/telemetry-contract/attributes` and fails to resolve
      // without them.
      ...storybookModuleAliases(repoRoot),
      // Source-consumed packages rooted at `/src`, which the webpack build does
      // not need (Next resolves them through package `exports`) but Vite does.
      "@repo/cost": path.resolve(repoRoot, "packages/cost/src"),
      "@repo/crewd": path.resolve(repoRoot, "packages/crewd/src"),
      "@repo": path.resolve(repoRoot, "packages"),
    },
  },
});
