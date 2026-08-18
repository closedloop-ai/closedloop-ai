import path from "node:path";
import { config, withAnalyzer } from "@repo/next-config";
import { withLogging } from "@repo/observability/next-config";
import type { NextConfig } from "next";
import { env } from "@/env";
import { prismaCliTracingIncludes } from "@/lib/build/prisma-cli-tracing";

let nextConfig: NextConfig = withLogging(config);

// PLN-1678: do not type-check inside the build. Next 16.3 runs the TypeScript
// CLI instead of the in-process compiler API (`experimental.useTypeScriptCli`,
// on by default), and `tsc` checks the WHOLE tsconfig project rather than only
// the files reachable from a route entry. That pulls in this app's test files,
// two of which import across app boundaries (`apps/desktop/src/shared/*` and
// `@repo/app/shared/api/*`) — trees the containerized E2E api image
// (apps/api/Dockerfile) deliberately does not COPY, so the build fails there on
// TS2307 while the same source type-checks fine in a full checkout.
//
// Same resolution as apps/app (ISS-5133): the type-check is not lost, it is
// OWNED by the required `typecheck` CI job, which runs `next typegen` first so
// the generated `.next/types/validator.ts` route-signature checks this build
// used to own are covered there instead. Removing that typegen step would
// silently drop that coverage, which is why
// __tests__/typecheck-owns-route-types.test.ts pins the two together.
nextConfig.typescript = { ignoreBuildErrors: true };

// ISS-5983: `/preview-schemas/ensure` SPAWNS the Prisma CLI, and a spawn is
// invisible to Next's file tracing — nothing it needs would ship without being
// named here.
//
// TWO different base directories are in play, and conflating them is why the
// first version of this config traced nothing. `outputFileTracingRoot` widens
// what may be COLLECTED (these paths all sit above `apps/api`, and it is the
// `apps/app` precedent), but the include GLOBS are matched by
// `next/dist/build/collect-build-traces.js` with `glob(pattern, { cwd: dir })`
// where `dir` is the Next PROJECT directory — `apps/api`. Hence `../../`:
// repo-root-relative globs silently match nothing.
//
// Keyed to that ONE route glob deliberately: tracing is per-route, so the CLI
// and its native engines land in the ensure function only and no other api
// route grows by a byte. The engine glob is a directory rather than a
// platform-specific filename because the Linux build produces
// `schema-engine-<platform>` and that identifier is Prisma's to change.
//
// `prismaCliTracingIncludes()` walks the pnpm store for the CLI's runtime
// dependency closure instead of hardcoding it: `@prisma/config` alone pulls
// `c12`, `effect` and friends, and node-glob does not follow the symlinks pnpm
// uses to wire them together, so an enumerated list would be both long and
// wrong at the next dependency bump.
//
// ISS-6403: that same non-following is why pnpm's `node_modules/.bin/prisma`
// shim is no longer traced. It was, and it resolved — but the shim `require`s
// `<bin>/../prisma/build/index.js`, a symlink into the store that no glob here
// matched, so the bundle carried a launcher with nothing to launch and every
// `migrate deploy` died MODULE_NOT_FOUND. The route now names the store
// entrypoint directly through `PRISMA_CLI_ENTRY`, so nothing resolves through
// `PATH` or through that symlink, and the store globs below are the whole
// contract.
nextConfig.outputFileTracingRoot = path.join(import.meta.dirname, "..", "..");
nextConfig.outputFileTracingIncludes = {
  ...nextConfig.outputFileTracingIncludes,
  "/preview-schemas/ensure": [
    "../../packages/database/prisma/schema.prisma",
    "../../packages/database/prisma/migrations/**",
    "../../packages/database/prisma-runtime/**",
    ...prismaCliTracingIncludes(path.join(import.meta.dirname, "..", "..")),
  ],
};

if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
}

export default nextConfig;
