import { describe, expect, it } from "vitest";
import {
  ANY_CREATE_INDEX_G,
  migrationDdl,
  scanCreateIndexStatements,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-12552: the backfill's run record. The script finds an
 * unfinished run with the same policy and extractor versions and organization
 * scope to resume, and
 * this pins the one index that lookup uses. Reads declarative migration.sql
 * only.
 */
const MIGRATION = "20261023030102_iss12552_attribution_backfill_runs";

describe(`${MIGRATION} migration DDL`, () => {
  it("indexes runs by versions, scope, then status, and nothing else", () => {
    const statements = scanCreateIndexStatements(MIGRATION);

    expect(
      migrationDdl(MIGRATION).match(ANY_CREATE_INDEX_G) ?? []
    ).toHaveLength(1);
    expect(statements).toEqual([
      expect.objectContaining({
        name: "attribution_backfill_runs_versions_status_idx",
        table: "attribution_backfill_runs",
        unique: false,
        keys: [
          "policy_version",
          "extractor_version",
          "organization_id",
          "status",
        ],
        predicate: null,
      }),
    ]);
  });
});
