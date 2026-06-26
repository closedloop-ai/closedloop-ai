/** Closed origin values for desktop application exception telemetry. */
export const AppExceptionOrigin = {
  PreInit: "pre_init",
  Main: "main",
  Renderer: "renderer",
} as const;

/** Literal union of desktop application exception telemetry origins. */
export type AppExceptionOrigin =
  (typeof AppExceptionOrigin)[keyof typeof AppExceptionOrigin];
