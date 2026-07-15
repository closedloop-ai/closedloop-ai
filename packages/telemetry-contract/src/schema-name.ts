/** Published telemetry schema discriminators used for validate and emit. */
export const TelemetrySchemaName = {
  App: "app",
  Resource: "resource",
  Span: "span",
  GenAi: "gen_ai",
  Sync: "sync",
  Permission: "permission",
  Ipc: "ipc",
} as const;

/** Literal union of supported telemetry schema names. */
export type TelemetrySchemaName =
  (typeof TelemetrySchemaName)[keyof typeof TelemetrySchemaName];
