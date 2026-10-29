import { describe, expect, it } from "vitest";
import {
  indexNamed,
  migrationDdl,
  parseIndexes,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

const migration = "20261008172000_route_analytics_covering_indexes";
const indexes = [
  {
    name: "artifact_links_project_facet_cover_idx",
    table: "artifact_links",
    keys: ["organization_id", "link_type", "source_id", "target_id", "id"],
  },
  {
    name: "branch_file_changes_totals_cover_idx",
    table: "branch_file_changes",
    keys: ["branch_artifact_id", "head_sha", "additions", "deletions"],
  },
];

describe("route analytics covering indexes", () => {
  it.each(indexes)(
    "covers $table without blocking writes",
    ({ name, table, keys }) => {
      const index = indexNamed(migration, name);
      expect(index.table).toBe(table);
      expect(index.keys).toEqual(keys);
      expect(index.method).toBe("btree");
      expect(index.concurrently).toBe(true);
      expect(index.ifNotExists).toBe(false);
    }
  );
  it("contains only the two independent index builds", () => {
    expect(parseIndexes(migration)).toHaveLength(2);
    expect(
      migrationDdl(migration).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });
});
