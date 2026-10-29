import { describe, expect, it } from "vitest";
import { PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS } from "../scripts/preview-heavy-migrations-core.mjs";
import {
  migrationDdl,
  parseForeignKeys,
  scanCreateIndexStatements,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-10170 — the two migrations that tie `pull_request_detail.organization_id`
 * to its branch artifact's organization, asserted statement by statement.
 *
 * WHAT THIS FILE IS. A structural guard over the migration TEXT: it proves the
 * migrations say what they must say. The behavioral half — that a real Postgres
 * refuses a mismatched row — is
 * `__tests__/integration/iss10170-pull-request-detail-branch-tenant-fk.integration.test.ts`
 * and needs `DATABASE_URL`. Neither one alone is the whole claim.
 *
 * WHAT IT ACTUALLY CATCHES. Every property below can be lost while both
 * migrations still exist under the same names and every other assertion stays
 * green. A unique index that loses `UNIQUE` still indexes the columns but can
 * no longer be a foreign-key target, so the second migration fails on deploy. A
 * key list in the other column order is a different key and matches no FK. A
 * `VALIDATE` that goes missing leaves the constraint `NOT VALID` — it would
 * then police new writes while silently tolerating every row already stored,
 * which is precisely the "enforced by convention" state the ticket is about,
 * wearing a constraint's name.
 *
 * Reads declarative migration.sql DDL only — never implementation source.
 */

const UNIQUE_MIGRATION = "20260915180000_iss10170_artifacts_org_id_unique";
const FK_MIGRATION =
  "20260915180100_iss10170_pull_request_detail_branch_tenant_fk";
const FK_NAME = "pull_request_detail_branch_artifact_tenant_fkey";
const UNIQUE_INDEX_NAME = "artifacts_org_id_key";
const VALIDATE_STATEMENT_RE =
  /ALTER\s+TABLE\s+"pull_request_detail"\s+VALIDATE\s+CONSTRAINT\s+"pull_request_detail_branch_artifact_tenant_fkey"/i;
const NOT_VALID_RE = /\bNOT\s+VALID\b/i;

describe("ISS-10170 artifacts (organization_id, id) unique", () => {
  const indexes = () => scanCreateIndexStatements(UNIQUE_MIGRATION);

  it("builds ONE unique index keyed org-then-id", () => {
    const built = indexes();
    expect(built).toHaveLength(1);
    // UNIQUE is the whole point: Postgres accepts only a unique constraint or
    // index as a foreign-key target, so a non-unique build here makes the FK
    // migration fail on deploy with "no unique constraint matching given keys".
    expect(built[0].unique).toBe(true);
    expect(built[0].name).toBe(UNIQUE_INDEX_NAME);
    expect(built[0].table).toBe("artifacts");
    // Order is identity: (id, organization_id) is a different key and would
    // match no foreign key declared the other way round.
    expect(built[0].keys).toEqual(["organization_id", "id"]);
  });

  it("builds CONCURRENTLY and without IF NOT EXISTS", () => {
    const [built] = indexes();
    // A plain build holds a lock on `artifacts` — the largest table in the
    // schema and on the desktop sync write path — for its whole duration.
    expect(built.concurrently).toBe(true);
    // With CONCURRENTLY a failed build leaves a same-named INVALID index, and
    // IF NOT EXISTS would no-op over it and record the migration as applied
    // over a permanently unusable index.
    expect(built.ifNotExists).toBe(false);
  });

  it("stays free of the constructs that force Prisma's whole-file transaction wrap", () => {
    // CREATE INDEX CONCURRENTLY cannot run inside a transaction block; Prisma
    // wraps the whole file when a statement carries dollar-quoting, an embedded
    // BEGIN/COMMIT, or a DROP INDEX, and every build then fails with SQLSTATE
    // 25001. Comments are stripped first, so the header may name them.
    expect(
      migrationDdl(UNIQUE_MIGRATION).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });

  it("is registered as plain-built on preview, under the name it ships under", () => {
    // A preview schema pre-stamps and then plain-rebuilds this index. Skipping
    // it instead would leave the preview without the key the NEXT migration's
    // ADD CONSTRAINT references, so that migration would fail outright. The
    // registration is keyed on the directory name and nothing else compares
    // the two, so a rename silently un-registers it.
    expect(PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS).toContain(
      UNIQUE_MIGRATION
    );
  });
});

describe("ISS-10170 pull_request_detail tenant foreign key", () => {
  const foreignKeys = () => parseForeignKeys(FK_MIGRATION);

  it("adds ONE composite FK from the denormalized tenant to the branch artifact", () => {
    const added = foreignKeys();
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe(FK_NAME);
    expect(added[0].table).toBe("pull_request_detail");
    // Both columns, in this order, against the unique built above. Dropping
    // `organization_id` from either side would leave a constraint that still
    // references the artifact but no longer says anything about the tenant —
    // which is the entire invariant.
    expect(added[0].columns).toBe('"organization_id", "branch_artifact_id"');
    expect(added[0].referencedTable).toBe("artifacts");
    expect(added[0].referencedColumns).toBe('"organization_id", "id"');
  });

  it("cascades the delete, matching the single-column FK it refines", () => {
    // `pull_request_detail_branch_artifact_id_fkey` already cascades from the
    // same parent row. A RESTRICT here would make deleting a branch artifact
    // fail instead, turning an additive constraint into a behavior change.
    expect(foreignKeys()[0].actions).toContain("ON DELETE CASCADE");
  });

  it("adds the constraint NOT VALID and then VALIDATEs it in the same migration", () => {
    const ddl = migrationDdl(FK_MIGRATION);
    // NOT VALID keeps ACCESS EXCLUSIVE to the catalog write; the scan then runs
    // under SHARE UPDATE EXCLUSIVE and blocks neither reads nor writes.
    expect(foreignKeys()[0].actions).toMatch(NOT_VALID_RE);
    // And the VALIDATE is what makes it retroactive. Without it the constraint
    // polices new writes only, tolerating every row already stored — the exact
    // unenforced state the ticket describes, wearing a constraint's name. It is
    // also the fail-closed preflight: the scan aborts the migration naming the
    // constraint if any existing row violates it.
    expect(ddl).toMatch(VALIDATE_STATEMENT_RE);
  });

  it("builds no index, so it is not a preview CONCURRENTLY migration", () => {
    // Asserted rather than assumed: an index added here would have to be
    // accounted for on preview, and would silently fail the drift guard that
    // scans the whole migration history.
    expect(scanCreateIndexStatements(FK_MIGRATION)).toEqual([]);
  });
});
