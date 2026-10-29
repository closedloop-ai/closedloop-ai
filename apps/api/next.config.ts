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
// wrong at the next dependency bump. It then applies one probe-derived
// exclusion set (`UNUSED_CLOSURE_LEAVES`) on top, to keep the deployed function
// under Vercel's 250 MB limit; that set's own rot risk is documented there.
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

// ISS-8556: the five @aws-sdk packages listed below are REQUIRED at runtime
// rather than bundled, because Turbopack emitted two different
// `[root-of-the-server]` chunks to the SAME output path and failed the
// production build with "Two or more assets with different content were emitted
// to the same output path".
//
// The two colliding chunks were read off disk before deciding anything, and
// neither contained a byte of Prisma: one was `@aws-sdk/credential-provider-sso`
// plus the SSO token providers, the other the Lambda `InvokeStore` and smithy
// helpers. Both reach the server graph only through lazy `import()`s inside the
// credential chain, from two different entries — so Turbopack built two chunk
// groups and named them identically. The Prisma 7.10 client did not cause it;
// it perturbed the module graph enough to expose a chunk-NAME collision that
// 7.8 happened to miss. Main builds green with the identical
// whole-project-tracing warnings, which is how that was ruled out as the cause:
// removing one of those warnings locally left the collision exactly where it
// was.
//
// `@aws-sdk/rds-signer` is in the list for a reason worth stating: it is
// imported at TOP LEVEL by `packages/database/index.ts`, which is in the server
// graph of essentially every api route, and it reaches the same
// `credential-provider-node` -> `credential-provider-sso` chain. Externalizing
// only the four direct api dependencies would have left that entry point
// bundled, so the collision class would have been narrowed rather than removed.
//
// `@aws-sdk/credential-provider-node` joined the list for the identical reason
// (ISS-9108): `packages/database/aws-credentials.ts` imports its
// `defaultProvider` at top level for the non-Vercel credential fallback, and
// `packages/database/index.ts` imports THAT at top level, so it reaches the
// same chain from the same always-in-graph entry point.
//
// It names the narrow provider package rather than the `@aws-sdk/credential-
// providers` umbrella, which re-exports the identical provider as
// `fromNodeProviderChain` but also pulls `@aws-sdk/client-cognito-identity` and
// the Cognito/login providers. That is 68 fewer packages in the workspace
// resolution; it is NOT a smaller traced closure, because `@aws-sdk/rds-signer`
// depends on that umbrella itself, so those packages are already traced into
// these functions and this entry does not remove them.
//
// SCOPE: this externalizes the packages named below, not "the AWS SDK"
// generally. Any @aws-sdk package reached through another workspace and not
// listed here is still bundled.
//
// WHAT VERIFIES THIS. The green `next-build (api)` job (the collision is a
// build-time failure) and the green `Vercel - api-stage` deploy, which proves
// the traced function still builds and deploys. Note `server:import-smoke` does
// NOT verify it, despite running immediately after `next build`: it is a `tsx`
// import of one source module outside the Next build output, it asserts a
// single export is a function, and it never touches an @aws-sdk package. Nothing
// currently exercises these five from inside the emitted server bundle, so a
// resolution failure would surface at runtime — on the routes that use
// S3/KMS and, because `rds-signer` is reached through `@repo/database`, on
// essentially every route that touches the database. It is traced into 291 of
// the 301 emitted functions; the ten without it are genuinely database-free.
nextConfig.serverExternalPackages = [
  ...(nextConfig.serverExternalPackages ?? []),
  "@aws-sdk/client-kms",
  "@aws-sdk/client-s3",
  "@aws-sdk/credential-provider-node",
  "@aws-sdk/s3-request-presigner",
  "@aws-sdk/rds-signer",
];

if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
}

export default nextConfig;
