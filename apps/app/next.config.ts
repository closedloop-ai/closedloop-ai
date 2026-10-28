import path from "node:path";
import { config, withAnalyzer } from "@repo/next-config";
import { withLogging } from "@repo/observability/next-config";
import type { NextConfig } from "next";
import { env } from "@/env";
import { resolveDatadogRumBuildVersion } from "@/lib/datadog-rum/build-version";
import { DOCS_CORPUS_TRACE_GLOB } from "@/lib/docs-help/docs-corpus-trace-glob";
import { withTrustedLabels } from "../../scripts/analytics/trusted-label-next-config.mjs";
import { shouldEmitBrowserSourceMaps } from "./lib/datadog-rum/source-maps";

let nextConfig: NextConfig = withTrustedLabels(withLogging(config));

// ISS-5133: do not type-check inside the build. `next build` ran `tsc` in a
// jest-worker child that needs >2 GB of V8 heap (measured: it dies at a 2048 MB
// cap), inside a Vercel build container that affords each worker a ~2240 MB
// default heap on an 8 GB box. Sitting that close to the ceiling, the worker's
// GC thrash pushed the container over its cgroup limit and the container
// SIGKILLed it — 33 times in the 30 days to 2026-08-05, all on `app-stage`,
// always in the "Running TypeScript" phase and never during compile. Note the
// cap is NOT the lever: raising it lets the worker grow further (an explicit
// `--max-old-space-size=4096` yields a 4288 MB limit in that container), and
// lowering it turns the intermittent SIGKILL into a deterministic heap OOM.
//
// The type-check itself is not lost — it MOVED to the required `typecheck` CI
// job, which has the headroom for it. That job now runs `next typegen` first
// (see apps/app/package.json), so the generated `.next/types/validator.ts`
// route-signature checks this build used to own are covered there instead.
// Removing the typegen step would silently drop that coverage, which is why
// __tests__/typecheck-owns-route-types.test.ts pins the two together.
nextConfig.typescript = { ignoreBuildErrors: true };

// ISS-10949: the `@settings/[...unmatched]` catch-all takes the path below the
// org slug as its param. Optimistic routing re-resolves only the params on the
// URL's own path and copies that one from the known route it predicts from, so
// every predicted route asks the server for the wrong settings segment. Next
// (16.3.1+) answers the mismatch by invalidating the whole route cache, which
// re-prefetches every visible link and, with enough document links on screen,
// never settles. ISS-11392 removes that catch-all; when it lands, drop this
// override and `__tests__/optimistic-routing-catch-all-slot.test.ts`.
nextConfig.experimental = {
  ...nextConfig.experimental,
  optimisticRouting: false,
};

// ISS-13006: run React Compiler (`reactCompiler: true` in @repo/next-config)
// as Turbopack's native Rust port instead of the Babel plugin. On Next 16.4.1
// the Babel plugin runs in Turbopack's Node.js loader pool, whose processes
// stay alive through page-data collection and static generation, and that
// pool put this build at the edge of Vercel's 8 GB build machine. The
// before/after peaks and the per-module output comparison with the Babel
// plugin are on ISS-13006.
//
// Not with the bundle analyzer: it reports only from a webpack build (under
// Turbopack it writes nothing and says to pass `--webpack`), and Next's config
// validation throws on this flag when Turbopack is off, which failed
// `ANALYZE=true pnpm --filter app build --webpack` while loading this file.
if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
} else {
  nextConfig.experimental = {
    ...nextConfig.experimental,
    turbopackRustReactCompiler: true,
  };
}

// FEA-2133: opt into Next standalone output ONLY for the apps/app/Dockerfile
// image build (the E2E target and, since ISS-11832, the ECS stage image), which
// sets E2E_STANDALONE_BUILD=1. Vercel builds never set this flag, so their
// `output` is unchanged.
if (process.env.E2E_STANDALONE_BUILD === "1") {
  nextConfig.output = "standalone";
}

// Trace deps from the monorepo root so a standalone bundle includes the
// pnpm-linked @repo/* workspace packages, not just files under apps/app.
//
// UNCONDITIONAL SINCE ISS-10006, and this now applies to Vercel builds where it
// previously did not (tamsinb review — an earlier version of this comment
// claimed `main` already reassigned it for every build; it does not, it sets it
// once inside the standalone block above). What was checked before widening it:
// `apps/api/next.config.ts` has set exactly this value unconditionally for
// every build, Vercel included, and its comment calls this file the precedent
// it copied; and the value is the repo root Next already infers for a pnpm
// workspace whose lockfile sits there, so the widening pins that inference
// rather than moving it. What it buys is below —
// `outputFileTracingIncludes` is resolved against the tracing setup, and a root
// that differs between the standalone image and Vercel would mean the docs
// corpus is traced in one and silently absent in the other.
nextConfig.outputFileTracingRoot = path.join(import.meta.dirname, "..", "..");

// ISS-10006: Web Help serves the docs corpus that `apps/web` publishes, read off
// the deployment at request time. Nothing statically imports those `.mdx` and
// `meta.json` files, so Next's tracer cannot see them and the route handlers
// would deploy without a corpus to read — a 503 on every Help open, on Vercel
// and in the standalone E2E image alike, with every local suite still green
// because each of them stubs the read.
//
// RELATIVE TO THIS APP DIRECTORY, NOT TO `outputFileTracingRoot`
// (parkerbowen/architect review). Next globs these with `cwd` set to the Next
// project dir (`collect-build-traces.ts`), so a repo-root-looking
// `./apps/web/content/docs/**/*` resolves to `apps/app/apps/web/...` and matches
// exactly nothing — silently, because an include that matches no file is not an
// error. `apps/api/next.config.ts` spells its Prisma schema include the same
// relative way. `__tests__/docs-corpus-tracing.test.ts` globs this value and
// fails on an empty match, which is the only thing that can catch it pre-deploy.
nextConfig.outputFileTracingIncludes = {
  ...nextConfig.outputFileTracingIncludes,
  "/api/docs-help": [DOCS_CORPUS_TRACE_GLOB],
  "/api/docs-help/page": [DOCS_CORPUS_TRACE_GLOB],
  "/api/docs-help/search": [DOCS_CORPUS_TRACE_GLOB],
};

// ISS-7766: emitted only when the upload is on, so a build that cannot ship
// them to Datadog does not pay to produce maps it would immediately delete.
nextConfig.productionBrowserSourceMaps = shouldEmitBrowserSourceMaps(
  process.env
);

nextConfig.env = {
  ...nextConfig.env,
  NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION: resolveDatadogRumBuildVersion(
    process.env
  ),
  // Expose Vercel's per-deployment environment to the browser so RUM env
  // tagging (apps/app/lib/environment.ts) can distinguish preview/e2e
  // deployments from real prod/stage (FEA-1466). VERCEL_ENV is a server-only
  // system var; inline it here as NEXT_PUBLIC_* so it reaches client code.
  NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "",
};

export default nextConfig;
