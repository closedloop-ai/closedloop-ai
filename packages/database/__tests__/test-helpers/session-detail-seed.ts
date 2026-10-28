/**
 * The row chain `session_detail` needs above it before it can exist:
 * organization -> user -> compute target.
 *
 * Extracted on the SECOND copy, which is this repo's rule for a nontrivial test
 * fixture (root AGENTS.md: "When the same helper logic, object shape, protocol
 * type, or nontrivial test fixture appears in multiple files, extract it into the
 * nearest shared module or shared test fixture"). The first copy was ISS-8515's
 * `iss8515-estimated-cost-default-drop.integration.test.ts`; ISS-8517's backfill
 * test needed the identical three inserts a week later. `migration-index-ddl.ts`
 * in this directory was extracted the same way, for the same reason.
 *
 * Deliberately takes a `pg.Client` rather than Prisma: these suites run raw SQL
 * against a real database inside a transaction they roll back, and the point of
 * several of them is to observe what the COLUMN does rather than what the ORM
 * says it does.
 */

import { randomUUID } from "node:crypto";
import type { Client } from "pg";

export type SessionDetailSeed = {
  organizationId: string;
  computeTargetId: string;
};

/**
 * Insert the organization / user / compute-target chain and return the ids a
 * `session_detail` row needs. `label` distinguishes rows in a shared database
 * when a suite is debugged without its rollback.
 */
export async function seedSessionDetailParents(
  client: Client,
  label: string
): Promise<SessionDetailSeed> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const computeTargetId = randomUUID();

  await client.query(
    `INSERT INTO organizations (id, clerk_id, name, slug, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())`,
    [
      organizationId,
      `clerk_${organizationId}`,
      label,
      `${label}-${organizationId}`,
    ]
  );
  await client.query(
    `INSERT INTO users (id, clerk_id, organization_id, email, updated_at)
     VALUES ($1, $2, $3, $4, now())`,
    [userId, `clerk_${userId}`, organizationId, `${userId}@example.test`]
  );
  await client.query(
    `INSERT INTO compute_targets (id, organization_id, user_id, machine_name, platform, updated_at)
     VALUES ($1, $2, $3, $4, 'linux', now())`,
    [computeTargetId, organizationId, userId, label]
  );

  return { organizationId, computeTargetId };
}
