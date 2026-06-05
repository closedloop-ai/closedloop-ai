import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

type AppType = "app" | "web" | "api";

// Supported environment suffixes for Vercel project names
const ENV_SUFFIXES = ["stage", "prod"] as const;

/**
 * Determine which app this deployment belongs to based on Vercel URLs.
 *
 * For preview environments, uses VERCEL_BRANCH_URL which always follows the pattern:
 *   {appType}-{env}-git-{branch}-{team}.vercel.app
 *
 * This is more reliable than VERCEL_PROJECT_PRODUCTION_URL which can be a custom domain
 * (e.g., "marketing.localhost" instead of "web-stage.vercel.app").
 *
 * For production environments, falls back to VERCEL_PROJECT_PRODUCTION_URL.
 *
 * Returns null if not running on Vercel or pattern doesn't match.
 */
function getCurrentAppType(): AppType | null {
  // In preview, VERCEL_BRANCH_URL always uses the project name pattern
  const branchUrl = process.env.VERCEL_BRANCH_URL?.toLowerCase();
  const vercelUrl = process.env.VERCEL_URL?.toLowerCase();
  const productionUrl =
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.toLowerCase();

  // Try branch URL first (most reliable for previews), then VERCEL_URL, then production URL
  const urlToCheck = branchUrl ?? vercelUrl ?? productionUrl;
  if (!urlToCheck) {
    return null;
  }

  // Match pattern: {appType}-{env} at start of URL
  const appTypes: AppType[] = ["app", "web", "api"];
  for (const appType of appTypes) {
    for (const suffix of ENV_SUFFIXES) {
      if (urlToCheck.startsWith(`${appType}-${suffix}`)) {
        return appType;
      }
    }
  }
  return null;
}

/**
 * Extract the environment suffix (stage, prod) from the current Vercel URL.
 *
 * For preview environments, uses VERCEL_BRANCH_URL which always follows the pattern:
 *   {appType}-{env}-git-{branch}-{team}.vercel.app
 *
 * This is more reliable than VERCEL_PROJECT_PRODUCTION_URL which can be a custom domain.
 */
function getCurrentEnvSuffix(): string | null {
  // In preview, VERCEL_BRANCH_URL always uses the project name pattern
  const branchUrl = process.env.VERCEL_BRANCH_URL?.toLowerCase();
  const vercelUrl = process.env.VERCEL_URL?.toLowerCase();
  const productionUrl =
    process.env.VERCEL_PROJECT_PRODUCTION_URL?.toLowerCase();

  const urlToCheck = branchUrl ?? vercelUrl ?? productionUrl;
  if (!urlToCheck) {
    return null;
  }

  for (const suffix of ENV_SUFFIXES) {
    // Match pattern like "app-stage-" or "web-prod-" at start
    if (urlToCheck.includes(`-${suffix}`)) {
      return suffix;
    }
  }
  return null;
}

/**
 * Compute dynamic URL for preview deployments.
 *
 * In preview environments, we derive all app URLs from VERCEL_BRANCH_URL by
 * swapping the app type in the hostname. This enables full-stack preview
 * testing where app preview talks to API preview, etc.
 *
 * Note: We use VERCEL_BRANCH_URL (branch-based, consistent across apps) rather than
 * VERCEL_URL (deployment-specific ID, unique per deployment).
 *
 * Example: If VERCEL_BRANCH_URL is "app-stage-git-my-branch-closed-loop.vercel.app"
 * - APP_URL → https://app-stage-git-my-branch-closed-loop.vercel.app
 * - API_URL → https://api-stage-git-my-branch-closed-loop.vercel.app
 * - WEB_URL → https://web-stage-git-my-branch-closed-loop.vercel.app
 *
 * BUILD-TIME BEHAVIOR:
 * This function executes at build time. On Vercel preview builds, VERCEL_ENV and
 * VERCEL_BRANCH_URL are available, enabling cross-app URL derivation. For local
 * development or non-Vercel builds, these env vars are absent, and we gracefully
 * fall back to the configured NEXT_PUBLIC_*_URL values or localhost defaults.
 *
 * @param urlType - Which app this URL represents ("app", "web", or "api")
 * @param fallback - The configured env var value to use for non-preview
 */
const TRAILING_SLASHES = /\/+$/;
function stripTrailingSlashes(url: string): string {
  return url.replace(TRAILING_SLASHES, "");
}

function getDynamicUrl(urlType: AppType, fallback: string | undefined): string {
  const vercelEnv = process.env.VERCEL_ENV;
  // Use VERCEL_BRANCH_URL (consistent across deployments) then VERCEL_URL
  const branchUrl = process.env.VERCEL_BRANCH_URL ?? process.env.VERCEL_URL;
  const currentApp = getCurrentAppType();
  const envSuffix = getCurrentEnvSuffix();

  // Only apply preview URL derivation for actual Vercel preview deployments.
  // Production deployments (including staging deployed from main branch) should
  // use the configured NEXT_PUBLIC_*_URL values, not derive from VERCEL_BRANCH_URL.
  const isPreviewLike =
    vercelEnv === "preview" &&
    ((branchUrl?.includes(".preview.") ?? false) ||
      (branchUrl?.includes("-git-") ?? false));

  // In preview-like environments, derive all app URLs by swapping the app type
  if (isPreviewLike && branchUrl && currentApp && envSuffix) {
    // Match pattern: {appType}-{env}-git-... at start of URL
    // Use regex to swap the app type while preserving the rest
    const searchPattern = new RegExp(`^(${currentApp})(-${envSuffix})`);
    const match = branchUrl.match(searchPattern);

    if (match) {
      const targetUrl = branchUrl.replace(searchPattern, `${urlType}$2`);
      return stripTrailingSlashes(`https://${targetUrl}`);
    }
    // Pattern didn't match - log warning and fall through to fallback
    console.warn(
      `[next-config] Preview URL derivation failed: expected pattern "${currentApp}-${envSuffix}" not found at start of VERCEL_BRANCH_URL="${branchUrl}". Falling back to configured URL.`
    );
  }

  // Otherwise use the configured URL (staging/production) or localhost default
  const defaults: Record<AppType, string> = {
    app: "http://localhost:3000",
    web: "http://localhost:3001",
    api: "http://localhost:3002",
  };
  return stripTrailingSlashes(fallback ?? defaults[urlType]);
}

export const keys = () =>
  createEnv({
    server: {
      ANALYZE: z.string().optional(),

      // Added by Vercel
      NEXT_RUNTIME: z.enum(["nodejs", "edge"]).optional(),

      // Vercel environment variables
      VERCEL: z.string().optional(),
      VERCEL_ENV: z.enum(["development", "preview", "production"]).optional(),
      VERCEL_URL: z.string().optional(),
      VERCEL_BRANCH_URL: z.string().optional(),
      VERCEL_REGION: z.string().optional(),
      VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
    },
    client: {
      NEXT_PUBLIC_APP_URL: z.url(),
      NEXT_PUBLIC_WEB_URL: z.url(),
      NEXT_PUBLIC_API_URL: z.url().optional(),
      NEXT_PUBLIC_DOCS_URL: z.url().optional(),
    },
    runtimeEnv: {
      ANALYZE: process.env.ANALYZE,
      NEXT_RUNTIME: process.env.NEXT_RUNTIME,
      VERCEL: process.env.VERCEL,
      VERCEL_ENV: process.env.VERCEL_ENV,
      VERCEL_URL: process.env.VERCEL_URL,
      VERCEL_BRANCH_URL: process.env.VERCEL_BRANCH_URL,
      VERCEL_REGION: process.env.VERCEL_REGION,
      VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
      // Dynamic URLs: derive all preview URLs from VERCEL_BRANCH_URL for full-stack testing
      NEXT_PUBLIC_APP_URL: getDynamicUrl(
        "app",
        process.env.NEXT_PUBLIC_APP_URL
      ),
      NEXT_PUBLIC_WEB_URL: getDynamicUrl(
        "web",
        process.env.NEXT_PUBLIC_WEB_URL
      ),
      NEXT_PUBLIC_API_URL: getDynamicUrl(
        "api",
        process.env.NEXT_PUBLIC_API_URL
      ),
      NEXT_PUBLIC_DOCS_URL: process.env.NEXT_PUBLIC_DOCS_URL,
    },
  });
