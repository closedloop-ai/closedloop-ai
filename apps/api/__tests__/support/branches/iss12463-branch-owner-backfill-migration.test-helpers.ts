import { readFileSync } from "node:fs";

/**
 * The shipped ISS-12463 backfill migration with its candidate scan narrowed to
 * one organization. Unscoped, a run selects and row-locks every unassigned
 * branch in the database and holds them until the case rolls back, so a suite
 * running alongside (`branch-owner-seed-for-login.integration.test.ts`) sees
 * its own branches skipped as held, and the backfill suite's notice counts
 * include that suite's rows.
 */
export function corpusMigrationSql(organizationId: string): string {
  if (!UUID_RE.test(organizationId)) {
    throw new Error(`${MIGRATION}: not a uuid to scope by: ${organizationId}`);
  }
  const pieces = shippedMigrationSql().split(CANDIDATE_FILTER);
  // Scoping nothing would run the migration over the whole database again.
  if (pieces.length !== 2) {
    throw new Error(
      `${MIGRATION}: expected one candidate filter to scope, found ${pieces.length - 1}`
    );
  }
  return pieces.join(
    CANDIDATE_FILTER.replace(
      CANDIDATE_LIMIT,
      `        AND a.organization_id = '${organizationId}'::uuid\n${CANDIDATE_LIMIT}`
    )
  );
}

/**
 * The corpus-scoped file with the ceiling constant also lowered, so the abort
 * is reached without seeding 250,001 branches.
 */
export function migrationWithCeiling(
  ceiling: number,
  organizationId: string
): string {
  const shipped = corpusMigrationSql(organizationId);
  const lowered = shipped.replace(
    `${CEILING_DECLARATION} := ${SHIPPED_CEILING}`,
    `${CEILING_DECLARATION} := ${ceiling}`
  );
  // A replacement that matched nothing would run the success path while the
  // case claims to test the abort.
  if (lowered === shipped) {
    throw new Error(`${MIGRATION}: ceiling declaration not found to lower`);
  }
  return lowered;
}

function shippedMigrationSql(): string {
  return readFileSync(
    new URL(
      `../../../../../packages/database/prisma/migrations/${MIGRATION}/migration.sql`,
      import.meta.url
    ),
    "utf8"
  );
}

const MIGRATION = "20261019182000_iss12463_branch_owner_backfill";
const CEILING_DECLARATION = "max_inline_rows CONSTANT bigint";
const SHIPPED_CEILING = "250000";
const CANDIDATE_LIMIT = "     LIMIT max_inline_rows + 1";
const CANDIDATE_FILTER = `        AND a.assignee_id IS NULL\n${CANDIDATE_LIMIT}`;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
