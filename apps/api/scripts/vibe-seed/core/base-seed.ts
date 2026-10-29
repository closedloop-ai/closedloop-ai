import { SeedProfileName } from "@repo/database/scripts/seed/profiles";
import { runSeedProgram } from "@repo/database/scripts/seed/program";

/**
 * ISS-12017: the `@repo/database` base seed, run in-process the way the
 * preview seed route runs it (`runPreviewSeedInProcess`), into the local-trusted
 * org rather than the bootstrap sandbox identity.
 *
 * No `SEED_FORCE_OVERWRITE`: the seed's non-empty-org preflight
 * (`detectOrgConflicts`) looks at integrations, projects, teams, artifacts,
 * loops, comments, custom fields, and evaluations, and `findOrCreateUser`
 * writes only the Organization and User rows, so a freshly created org passes
 * clean. A rerun finds only deterministic seed-owned rows and reseeds
 * idempotently.
 */
export async function runBaseSeed(input: {
  databaseUrl: string;
  organizationId: string;
  userId: string;
  log: (message: string) => void;
}): Promise<void> {
  const write = (...parts: unknown[]) =>
    input.log(parts.map((part) => String(part)).join(" "));
  const logger = { log: write, warn: write, error: write };
  const result = await runSeedProgram({
    argv: [
      "--profile",
      SeedProfileName.CiPreview,
      "--organization-id",
      input.organizationId,
      "--user-id",
      input.userId,
    ],
    env: { ...process.env, DATABASE_URL: input.databaseUrl },
    logger,
  });
  if (result.exitCode !== 0) {
    throw new Error(`base seed failed: ${result.error ?? "unknown error"}`);
  }
}
