import {
  type AppEnvironment,
  resolveAppEnvironment,
} from "@repo/analytics/environment";
import { Surface } from "@repo/api/src/types/surface-analytics";

/** The browser and server use the same deployment policy for RUM and PostHog. */
export function getAppEnvironment(): AppEnvironment {
  return resolveAppEnvironment({
    surface: Surface.Web,
    publicDeploymentEnvironment: process.env.NEXT_PUBLIC_VERCEL_ENV,
    deploymentEnvironment: process.env.VERCEL_ENV,
    appEnvironment: process.env.NEXT_PUBLIC_APP_ENVIRONMENT,
    siteUrl: process.env.NEXT_PUBLIC_APP_URL,
  });
}

export const appEnvironment = getAppEnvironment();

/** Favicon / collapsed-sidebar icon per environment. */
export const envIconPath: Record<AppEnvironment, string> = {
  local: "/loop_icon_local.png",
  stage: "/loop_icon_staging.png",
  preview: "/loop_icon_staging.png",
  prod: "/loop_icon.png",
};
