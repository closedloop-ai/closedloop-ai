/**
 * Shared test helper: build a `spawnSync`-style deploy failure Error, matching
 * how migrate.ts's runMigrateDeploy throws — a generic Error carrying the
 * Prisma CLI's captured output on `.stderr`/`.stdout`. Single source of truth
 * for both migrate-deploy-recovery.test.ts and migrate-registry-retry.test.ts.
 */

export type DeployError = Error & {
  stdout?: string;
  stderr?: string;
};

export function makeDeployError(input: {
  message?: string;
  stdout?: string;
  stderr?: string;
}): DeployError {
  const error: DeployError = new Error(input.message ?? "deploy failed");
  error.stdout = input.stdout ?? "";
  error.stderr = input.stderr ?? "";
  return error;
}
