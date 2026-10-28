export const AppBootFailureKind = {
  MigrationRefusal: "migration_refusal",
  ModuleResolution: "module_resolution",
  StoreOpenTimeout: "store_open_timeout",
  Unknown: "unknown",
} as const;

/** Literal union of `app.boot_failure.kind` values. */
export type AppBootFailureKind =
  (typeof AppBootFailureKind)[keyof typeof AppBootFailureKind];

export const AppBootFailureOutcome = {
  Failed: "failed",
  Recovered: "recovered",
} as const;

/** Literal union of `app.boot_failure.outcome` values. */
export type AppBootFailureOutcome =
  (typeof AppBootFailureOutcome)[keyof typeof AppBootFailureOutcome];
