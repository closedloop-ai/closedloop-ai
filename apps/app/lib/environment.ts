export type AppEnvironment = "local" | "stage" | "preview" | "prod";

// The canonical production app host. Only a NEXT_PUBLIC_APP_URL pointing at
// this host is treated as prod by the URL fallback below.
const PRODUCTION_APP_HOST = "app.closedloop.ai";

/**
 * Detect the current deployment environment for telemetry tagging (Datadog RUM).
 *
 * Priority:
 *  1. VERCEL_ENV === "preview" → "preview". Vercel sets VERCEL_ENV automatically
 *     per deployment, so this is authoritative and cannot be defeated by a
 *     mis-scoped NEXT_PUBLIC_APP_ENVIRONMENT. A preview / e2e deployment is never
 *     prod or canonical stage; tagging it "preview" keeps the env:prod (and
 *     env:stage) RUM slices clean of automation noise (FEA-1466).
 *  2. VERCEL_ENV === "development" → "local".
 *  3. Otherwise — VERCEL_ENV === "production" (which covers BOTH real prod and
 *     the stage deployment, since stage also deploys to a Vercel production
 *     target) or VERCEL_ENV unset (local / tests) — split prod vs stage via the
 *     explicit NEXT_PUBLIC_APP_ENVIRONMENT, then a positive-prod-only URL
 *     heuristic on NEXT_PUBLIC_APP_URL. Unknown hosts resolve to "stage", never
 *     "prod", so an unrecognized deployment can never pollute env:prod.
 *
 * VERCEL_ENV is read client-side via the build-time-inlined NEXT_PUBLIC_VERCEL_ENV
 * (mapped in apps/app/next.config.ts) and server-side via the raw VERCEL_ENV.
 */
export function getAppEnvironment(): AppEnvironment {
  const vercelEnv = getVercelEnv();
  if (vercelEnv === "preview") {
    return "preview";
  }
  if (vercelEnv === "development") {
    return "local";
  }

  const explicit = process.env.NEXT_PUBLIC_APP_ENVIRONMENT;
  if (explicit === "production") {
    return "prod";
  }
  if (explicit === "stage") {
    return "stage";
  }
  if (explicit === "development") {
    return "local";
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  if (appUrl.includes("localhost")) {
    return "local";
  }
  if (isProductionHost(appUrl)) {
    return "prod";
  }
  return "stage";
}

// Exact host match (not a substring) so a host like
// `app.closedloop.ai.preview.example.com` is NOT mistaken for production.
function isProductionHost(appUrl: string): boolean {
  try {
    return new URL(appUrl).hostname === PRODUCTION_APP_HOST;
  } catch {
    return false;
  }
}

// Vercel sets VERCEL_ENV ("development" | "preview" | "production") per
// deployment. The browser reads the build-time-inlined NEXT_PUBLIC_VERCEL_ENV;
// server and test contexts fall back to the raw VERCEL_ENV.
function getVercelEnv(): string | undefined {
  return process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV;
}

export const appEnvironment = getAppEnvironment();

/** Favicon / collapsed-sidebar icon per environment. */
export const envIconPath: Record<AppEnvironment, string> = {
  local: "/loop_icon_local.png",
  stage: "/loop_icon_staging.png",
  preview: "/loop_icon_staging.png",
  prod: "/loop_icon.png",
};
