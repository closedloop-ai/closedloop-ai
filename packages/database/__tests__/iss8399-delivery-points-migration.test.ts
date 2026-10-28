import { describe, expect, it } from "vitest";
import {
  MAX_IDENTIFIER_LENGTH,
  parseForeignKeys,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-8399 — the indexes and foreign keys that ship with `delivery_points` and
 * `delivery_point_artifacts` (`packages/database/AGENTS.md` requires focused
 * DDL coverage for every new index, constraint, or foreign key).
 *
 * WHY NOTHING ELSE CATCHES THIS. The backfill suite runs against an in-memory
 * fake, so it cannot see a constraint name, a missing UNIQUE, or a missing
 * cascade. Prisma's drift check compares this migration against
 * `schema.prisma`, so a matching pair of MISTAKES is green there too. Two
 * objects here are load-bearing at runtime and invisible from TypeScript:
 *
 * - The `(organization_id, provider, provider_item_id)` UNIQUE is what makes
 *   the backfill idempotent. Without an arbiter, `upsert` has nothing to
 *   conflict on and every overlapping delivery window INSERTS the same provider
 *   row again — the numerator inflating a little on each pass, forever, and
 *   looking exactly like growth.
 * - `SET NULL` on the pull-request and branch references (not CASCADE) keeps a
 *   measured delivery row alive when the record it matched is deleted. CASCADE
 *   would delete the measurement along with the match, turning a re-matchable
 *   row into a silent gap in coverage.
 *
 * Each assertion is scoped to ONE parsed statement, so a clause satisfied
 * elsewhere in the file cannot stand in for the object under test.
 *
 * Reads declarative migration.sql DDL only — not implementation source.
 */

const MIGRATION_NAME = "20260828120000_iss8399_delivery_points";
const POINTS_TABLE = "delivery_points";
const ASSOCIATIONS_TABLE = "delivery_point_artifacts";

/**
 * Names repeated as literals rather than derived from the DDL. These are PINS:
 * renaming an index has to change this file too, so a rename is a decision
 * somebody makes rather than one that rides along silently. Prisma generates
 * them from the `map:` names in `schema.prisma` and disagrees with the database
 * if the SQL ever spells one differently.
 */
const IDEMPOTENCY_KEY = "delivery_points_org_provider_item_key";
const DELIVERED_INDEX = "delivery_points_org_provider_delivered_idx";
const BRANCH_INDEX = "delivery_points_org_provider_branch_idx";
const INTERACTION_INDEX = "delivery_points_org_provider_interaction_idx";
const ASSOCIATION_INDEX = "delivery_point_artifacts_org_artifact_idx";

const indexes = () => scanCreateIndexStatements(MIGRATION_NAME);
const foreignKeys = () => parseForeignKeys(MIGRATION_NAME);

function indexNamed(name: string) {
  const found = indexes().find((index) => index.name === name);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no CREATE INDEX statement named "${name}" was parsed from migration.sql`
    );
  }
  return found;
}

function foreignKeyNamed(name: string) {
  const found = foreignKeys().find((key) => key.name === name);
  if (!found) {
    throw new Error(
      `${MIGRATION_NAME}: no foreign key named "${name}" was parsed from migration.sql`
    );
  }
  return found;
}

describe(`${MIGRATION_NAME} index DDL`, () => {
  it("creates exactly the five indexes this feature declares", () => {
    // An exhaustive comparison rather than a membership check: an extra index
    // nobody accounted for is a lock and a write cost that no review saw.
    expect(
      indexes()
        .map((index) => index.name)
        .sort()
    ).toEqual(
      [
        ASSOCIATION_INDEX,
        BRANCH_INDEX,
        DELIVERED_INDEX,
        INTERACTION_INDEX,
        IDEMPOTENCY_KEY,
      ].sort()
    );
  });

  it("makes the provider row id the UNIQUE upsert arbiter", () => {
    const index = indexNamed(IDEMPOTENCY_KEY);
    expect(index.table).toBe(POINTS_TABLE);
    // `toEqual` on the ordered key list, not a contains-check: a composite that
    // merely INCLUDES provider_item_id does not constrain one row per provider
    // record, and a membership assertion would accept it.
    expect(index.keys).toEqual([
      "organization_id",
      "provider",
      "provider_item_id",
    ]);
    // Without UNIQUE the upsert has no ON CONFLICT target and every overlapping
    // delivery window re-inserts the same provider row.
    expect(index.unique).toBe(true);
  });

  it("indexes the interaction id, which is how a creator row resolves later", () => {
    // A creator row carries no pull-request number; it gets one when a sibling
    // review row arrives in some other window. That re-resolution reads by
    // interaction id, so this index is the access path, not decoration.
    expect(indexNamed(INTERACTION_INDEX).keys).toEqual([
      "organization_id",
      "provider",
      "provider_interaction_id",
    ]);
  });

  it("indexes the branch artifact, which is a matched PR's real identity", () => {
    expect(indexNamed(BRANCH_INDEX).keys).toEqual([
      "organization_id",
      "provider",
      "branch_artifact_id",
    ]);
  });

  it("indexes the backfill's own by-window re-read", () => {
    expect(indexNamed(DELIVERED_INDEX).keys).toEqual([
      "organization_id",
      "provider",
      "delivered_on",
    ]);
  });

  it("indexes the artifact side of the many-to-many association", () => {
    // The read direction for "which delivery points reference this issue" —
    // the primary key leads with delivery_point_id and cannot serve it.
    const index = indexNamed(ASSOCIATION_INDEX);
    expect(index.table).toBe(ASSOCIATIONS_TABLE);
    expect(index.keys).toEqual(["organization_id", "artifact_id"]);
  });

  it("builds every index IF NOT EXISTS, as the index-lock exception requires", () => {
    // These builds take ACCESS EXCLUSIVE, which is only safe because both
    // tables are created empty in this same migration; CONCURRENTLY cannot be
    // mixed with that DDL. The exception is granted on the IF NOT EXISTS
    // spelling, so a retried migration is idempotent.
    for (const index of indexes()) {
      expect(index.ifNotExists).toBe(true);
      expect(index.concurrently).toBe(false);
    }
  });

  it("keeps every index name inside PostgreSQL's identifier limit", () => {
    // Read off the PARSED name, not the constant: a name past 63 chars is
    // truncated SILENTLY, and the truncated form is what Prisma's drift check
    // would then disagree with.
    for (const index of indexes()) {
      expect(index.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    }
  });
});

describe(`${MIGRATION_NAME} foreign key DDL`, () => {
  it("adds exactly the seven foreign keys this feature declares", () => {
    // Exhaustive rather than a membership check: an unaccounted-for reference
    // carries a delete behaviour nobody reviewed.
    expect(
      foreignKeys()
        .map((key) => key.name)
        .sort()
    ).toEqual(
      [
        "delivery_point_artifacts_artifact_id_fkey",
        "delivery_point_artifacts_delivery_point_id_fkey",
        "delivery_point_artifacts_organization_id_fkey",
        "delivery_points_branch_artifact_id_fkey",
        "delivery_points_organization_id_fkey",
        "delivery_points_pull_request_detail_id_fkey",
        "delivery_points_user_id_fkey",
      ].sort()
    );
  });

  it("cascades an organization delete so no delivery row outlives its tenant", () => {
    expect(
      foreignKeyNamed("delivery_points_organization_id_fkey").actions
    ).toContain("ON DELETE CASCADE");
    expect(
      foreignKeyNamed("delivery_point_artifacts_organization_id_fkey").actions
    ).toContain("ON DELETE CASCADE");
  });

  it("cascades an association when its delivery point or artifact goes away", () => {
    // An association to a deleted artifact is not a partial answer, it is a
    // dangling one; there is nothing left to attribute points to.
    expect(
      foreignKeyNamed("delivery_point_artifacts_delivery_point_id_fkey").actions
    ).toContain("ON DELETE CASCADE");
    expect(
      foreignKeyNamed("delivery_point_artifacts_artifact_id_fkey").actions
    ).toContain("ON DELETE CASCADE");
  });

  it("nulls the match references rather than deleting the measurement", () => {
    // CASCADE here would delete a MEASURED delivery row because the record it
    // matched went away — turning a re-matchable row into a coverage gap that
    // reads as "the provider reported nothing". The default (NO ACTION) is
    // equally wrong in the other direction: it would block the delete.
    const detail = foreignKeyNamed(
      "delivery_points_pull_request_detail_id_fkey"
    );
    expect(detail.referencedTable).toBe("pull_request_detail");
    expect(detail.actions).toContain("ON DELETE SET NULL");

    const branch = foreignKeyNamed("delivery_points_branch_artifact_id_fkey");
    expect(branch.referencedTable).toBe("artifacts");
    expect(branch.actions).toContain("ON DELETE SET NULL");
  });

  it("nulls the bridged user rather than deleting their delivery history", () => {
    const user = foreignKeyNamed("delivery_points_user_id_fkey");
    expect(user.referencedTable).toBe("users");
    expect(user.actions).toContain("ON DELETE SET NULL");
  });

  it("keeps every foreign-key name inside PostgreSQL's identifier limit", () => {
    for (const key of foreignKeys()) {
      expect(key.name.length).toBeLessThanOrEqual(MAX_IDENTIFIER_LENGTH);
    }
  });
});
