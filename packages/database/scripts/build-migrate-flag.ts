/** Named once so the predicate and the skip line cannot drift apart. */
const BUILD_MIGRATE_ENABLED_VAR = "BUILD_MIGRATE_ENABLED";

/**
 * Explicit falsy tokens that disable the build-time migrate. Anything else —
 * including unset — leaves it enabled.
 */
const BUILD_MIGRATE_DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

/** Fields the skip line carries; all non-sensitive env, never the signed database URL. */
export type BuildMigrateSkipLineInput = {
  /** The schema the build would have migrated (`null` = the `public` schema). */
  schema: string | null;
  env?: NodeJS.ProcessEnv;
};

/**
 * The build-time migrate is ON unless `BUILD_MIGRATE_ENABLED` is an explicit
 * falsy token. See the module header for why the polarity is inverted relative
 * to `isPreviewMigratorEnabled`.
 */
export function isBuildMigrateEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = env[BUILD_MIGRATE_ENABLED_VAR];
  return (
    raw === undefined ||
    !BUILD_MIGRATE_DISABLED_VALUES.has(raw.trim().toLowerCase())
  );
}

/**
 * One structured line naming why the build did not migrate. This is what the
 * Phase-4 verification gate reads out of the build log to prove a build made no
 * `:5432` traffic, and it reaches Datadog through the existing Vercel log drain.
 *
 * Deliberately NOT a `migrate_deploy` telemetry event: that contract's `outcome`
 * is the terminal state of a run that actually happened, and its rows are what
 * the P1002 concurrency and hold-cost queries count. A skip is not a run, so
 * emitting one would inflate every one of those queries.
 *
 * Both severity keys are explicit because Datadog reserves `status`, while
 * `level` keeps this line compatible with the shared logger's output contract.
 */
export function formatBuildMigrateSkipLine({
  schema,
  env = process.env,
}: BuildMigrateSkipLineInput): string {
  return JSON.stringify({
    level: "info",
    status: "info",
    message: "build_migrate_skipped",
    reason: `${BUILD_MIGRATE_ENABLED_VAR}=${env[BUILD_MIGRATE_ENABLED_VAR]}`,
    schema,
    vercel_env: env.VERCEL_ENV ?? null,
    git_ref: env.VERCEL_GIT_COMMIT_REF ?? null,
    deployment_id: env.VERCEL_DEPLOYMENT_ID ?? null,
  });
}
