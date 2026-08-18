/**
 * Build-time migrate kill-switch (ISS-4489, PLN-1629 Phase 1).
 *
 * `@repo/database`'s `prebuild` runs `scripts/migrate.ts`, so every `apps/api`
 * Vercel build opens a direct `:5432` connection to RDS. That build-time DB
 * access is the ONLY reason api-stage builds must stay attached to Secure
 * Compute — and while a build is attached, every byte it moves (git clone,
 * `pnpm install`, build-cache up/download) is billed as Private Data Transfer.
 * On api-stage that is ~$5.9k/mo, independent of how often we deploy.
 *
 * `BUILD_MIGRATE_ENABLED=0` skips the whole pipeline BEFORE any connection is
 * opened, which is the prerequisite for turning "use static IPs for builds" off
 * on that project. It is also the rollback lever for the flip: restoring the
 * build-time migrate is then an env change plus a redeploy, not a code revert.
 *
 * ## Polarity is the inverse of `isPreviewMigratorEnabled`, deliberately
 * The preview-migrator walk is an opt-IN feature, so it stays off unless an
 * explicit truthy token turns it on. This is a kill-switch over behavior that
 * ships today, so it stays ON unless an explicit falsy token turns it off:
 * unset, empty, a typo, or a value some future tool injects all keep migrations
 * running, which is the safe direction to fail.
 *
 * The explicit token set is the load-bearing part in both directions. A bare
 * `if (env.BUILD_MIGRATE_ENABLED)` reads `"0"` as enabled; a bare
 * `env.BUILD_MIGRATE_ENABLED !== "false"` misses `"0"`. cl-tofu writes `"0"`,
 * matching its existing `PREVIEW_MIGRATOR_ENABLED` block, so a predicate that
 * missed `"0"` would leave the build migrating after the toggle flip and break
 * every api-stage build — the exact failure this switch exists to prevent.
 *
 * Scope note: this gates `scripts/migrate.ts` wherever it runs, which is the
 * Vercel `prebuild` AND the containerized E2E stack (`e2e/compose.yml`). Only
 * the api-stage Vercel project ever sets the token, so E2E and local `pnpm
 * build` are unaffected by default.
 *
 * No I/O or env reads at module load — sibling-lib pattern, see
 * `migrate-retry.ts` / `migrate-telemetry.ts`.
 */

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
 */
export function formatBuildMigrateSkipLine({
  schema,
  env = process.env,
}: BuildMigrateSkipLineInput): string {
  return JSON.stringify({
    level: "info",
    message: "build_migrate_skipped",
    reason: `${BUILD_MIGRATE_ENABLED_VAR}=${env[BUILD_MIGRATE_ENABLED_VAR]}`,
    schema,
    vercel_env: env.VERCEL_ENV ?? null,
    git_ref: env.VERCEL_GIT_COMMIT_REF ?? null,
    deployment_id: env.VERCEL_DEPLOYMENT_ID ?? null,
  });
}
