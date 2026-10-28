import path from "node:path";
import {
  automaticJsx,
  pinnedReporters,
  resolveLaneWorkers,
  shardFromEnv,
} from "@repo/vitest-config";
import { defineConfig } from "vitest/config";

// ISS-7884: apps/web declared no `test:coverage`, so `discoverCoveragePackages`
// skipped it and the whole app contributed zero rows to the repo-wide report.
//
// Deliberately far smaller than apps/app's config, and each omission is load-bearing:
//   - `environment` stays on the `node` default. Every component suite renders
//     through `react-dom/server`, which needs no DOM, so nothing here has asked
//     for jsdom yet. A test that needs an EFFECT to run does — `useEffect` never
//     fires in a server render — which is why `site-banner.tsx` and
//     `newsletter-form.tsx` are the two files ISS-9276 left uncovered.
//   - No `bracketRouteAliasPlugin`. That plugin exists in apps/app so `@/`
//     specifiers resolve inside `app/[locale]/**` files, which are reached by
//     absolute path. The suites here reach those files through the `@` alias
//     below instead, which resolves before the bracket path ever matters.
//   - No catch-all `@repo` alias. `@repo/seo` is pnpm-symlinked into
//     apps/web/node_modules and resolves on its own, and a catch-all would
//     re-point the packages that already work. `@repo/design-system` is the one
//     exception and is aliased explicitly below.
//
// The `oxc` pin is NOT an omission and must stay: apps/web extends
// `@repo/typescript-config/nextjs.json`, whose `jsx: "preserve"` (meant for
// Next's own compiler) Vite honors, so without the pin JSX reaches Vite's
// parser untransformed.
export default defineConfig({
  oxc: automaticJsx(),
  test: {
    reporters: pinnedReporters(),
    // ISS-10902 — see resolveLaneWorkers for why a lane declares its width.
    maxWorkers: resolveLaneWorkers(),
    ...shardFromEnv(),
  },
  resolve: {
    alias: {
      // Unit tests exercise the real loader without Next's generated MDX input.
      "@/.source/server": path.resolve(
        import.meta.dirname,
        "./__tests__/support/docs-source.ts"
      ),
      "@": path.resolve(import.meta.dirname, "./"),
      // ISS-9276: `packages/design-system` imports ITSELF by name
      // (`@repo/design-system/lib/utils` inside its own `components/ui/*`), and
      // the package has neither a self-link nor an `exports` map — Next's
      // bundler resolves that from the workspace root, Vite does not. Without
      // this, any suite rendering a component that reaches the design system
      // dies on `Cannot find package '@repo/design-system/lib/utils'`.
      "@closedloop-ai/design-system": path.resolve(
        import.meta.dirname,
        "../../packages/design-system"
      ),
      "@repo/design-system": path.resolve(
        import.meta.dirname,
        "../../packages/design-system"
      ),
      // FEA-3570: the gated GitHub logo reaches `@repo/analytics/client`, which
      // imports `@posthog/next` — unresolvable outside a bundler. Same alias
      // `apps/app` already carries, for the same reason.
      "@posthog/next": path.resolve(
        import.meta.dirname,
        "./vitest-mocks/posthog-next.tsx"
      ),
    },
  },
});
