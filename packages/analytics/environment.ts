import { Surface } from "@repo/api/src/types/surface-analytics";

export const AppEnvironment = {
  Production: "prod",
  Stage: "stage",
  Preview: "preview",
  Development: "local",
} as const;
export type AppEnvironment =
  (typeof AppEnvironment)[keyof typeof AppEnvironment];

export const PRODUCTION_APP_HOST = "app.closedloop.ai";

export type EnvironmentInputs = {
  surface: typeof Surface.Web | typeof Surface.Marketing;
  deploymentEnvironment?: string;
  publicDeploymentEnvironment?: string;
  appEnvironment?: string;
  siteUrl?: string;
};

/** Shared telemetry policy; preserve the app's precedence for every consumer. */
export function resolveAppEnvironment(
  inputs: EnvironmentInputs
): AppEnvironment {
  // The public value is inlined for browser consumers by the app's Next config.
  const deployment =
    inputs.publicDeploymentEnvironment ?? inputs.deploymentEnvironment;
  if (deployment === "preview") {
    return AppEnvironment.Preview;
  }
  if (deployment === "development") {
    return AppEnvironment.Development;
  }
  switch (inputs.appEnvironment) {
    case "production":
      return AppEnvironment.Production;
    case "stage":
      return AppEnvironment.Stage;
    case "development":
      return AppEnvironment.Development;
    default:
      break;
  }
  const siteUrl = inputs.siteUrl ?? "";
  // Retain existing app telemetry behavior, including its localhost substring check.
  if (siteUrl.includes("localhost")) {
    return AppEnvironment.Development;
  }
  return isProductionHost(siteUrl, inputs.surface)
    ? AppEnvironment.Production
    : AppEnvironment.Stage;
}

// Exact hosts protect the production slice from deployment aliases and suffix matches.
export function isProductionHost(
  siteUrl: string,
  surface: EnvironmentInputs["surface"] = Surface.Web
): boolean {
  try {
    return PRODUCTION_HOSTS[surface].includes(new URL(siteUrl).hostname);
  } catch {
    return false;
  }
}

const PRODUCTION_HOSTS: Record<
  EnvironmentInputs["surface"],
  readonly string[]
> = {
  [Surface.Web]: [PRODUCTION_APP_HOST],
  [Surface.Marketing]: ["www.closedloop.ai", "closedloop.ai"],
};
