export type AppEnvironment = "local" | "stage" | "prod";

/**
 * Detect the current deployment environment from the app URL.
 *
 * Uses NEXT_PUBLIC_APP_URL which is available in both server and client
 * contexts. The value is set at build time by next-config/keys.ts via
 * getDynamicUrl(), so it reliably reflects the target environment.
 */
export function getAppEnvironment(): AppEnvironment {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "";
  if (appUrl.includes("localhost")) {
    return "local";
  }
  if (appUrl.includes("stage")) {
    return "stage";
  }
  return "prod";
}

export const appEnvironment = getAppEnvironment();

/** Favicon / collapsed-sidebar icon per environment. */
export const envIconPath: Record<AppEnvironment, string> = {
  local: "/loop_icon_local.png",
  stage: "/loop_icon_staging.png",
  prod: "/loop_icon.png",
};
