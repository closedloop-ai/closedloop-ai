import { config, withAnalyzer } from "@repo/next-config";
import { withLogging } from "@repo/observability/next-config";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";
import { env } from "@/env";

const withMDX = createMDX();

let nextConfig: NextConfig = withMDX(withLogging(config));

// Serve the self-contained attendee-prep one-pager at a clean URL.
// The file lives in public/ as a static asset; this maps the extensionless
// path to it. The route is excluded from the i18n/security middleware in
// proxy.ts so the locale rewriteDefault strategy doesn't rewrite the path.
const existingRewrites = nextConfig.rewrites;
nextConfig.rewrites = async () => {
  const ibClaudeTrainingRewrite = {
    source: "/ib-claude-training",
    destination: "/ib-claude-training.html",
  };

  const resolved = await existingRewrites?.();

  // Must be a beforeFiles rewrite: the `app/[locale]` dynamic segment would
  // otherwise match `/ib-claude-training` (treating it as a locale) before the
  // static file is reached.
  if (Array.isArray(resolved)) {
    return { beforeFiles: [ibClaudeTrainingRewrite], afterFiles: resolved };
  }

  if (resolved) {
    return {
      ...resolved,
      beforeFiles: [ibClaudeTrainingRewrite, ...(resolved.beforeFiles ?? [])],
    };
  }

  return { beforeFiles: [ibClaudeTrainingRewrite] };
};

if (process.env.NODE_ENV === "production") {
  const redirects: NextConfig["redirects"] = async () => [
    {
      source: "/legal",
      destination: "/legal/privacy",
      statusCode: 301,
    },
  ];

  nextConfig.redirects = redirects;
}

if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
}

export default nextConfig;
