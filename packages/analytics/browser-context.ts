import {
  type AppEnvironment,
  type EnvironmentInputs,
  resolveAppEnvironment,
} from "./environment";

export type BrowserAnalyticsContext = Readonly<{
  surface: EnvironmentInputs["surface"];
  environment: AppEnvironment;
}>;

/** Entrypoints pass deployment metadata; no persisted person/tab value is used. */
export function resolveBrowserAnalyticsContext(
  inputs: EnvironmentInputs
): BrowserAnalyticsContext {
  return {
    surface: inputs.surface,
    environment: resolveAppEnvironment(inputs),
  };
}
