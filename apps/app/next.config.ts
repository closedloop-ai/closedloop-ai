import path from "node:path";
import { config, withAnalyzer } from "@repo/next-config";
import { withLogging } from "@repo/observability/next-config";
import type { NextConfig } from "next";
import { env } from "@/env";
import { resolveDatadogRumBuildVersion } from "@/lib/datadog-rum/build-version";

let nextConfig: NextConfig = withLogging(config);

if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
}

// FEA-2133: opt into Next standalone output ONLY for the containerized E2E
// image build, which sets E2E_STANDALONE_BUILD=1 in apps/app/Dockerfile.
// Vercel builds never set this flag, so their output behaviour is unchanged.
if (process.env.E2E_STANDALONE_BUILD === "1") {
  nextConfig.output = "standalone";
  // Trace deps from the monorepo root so the standalone bundle includes the
  // pnpm-linked @repo/* workspace packages, not just files under apps/app.
  nextConfig.outputFileTracingRoot = path.join(import.meta.dirname, "..", "..");
}

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
