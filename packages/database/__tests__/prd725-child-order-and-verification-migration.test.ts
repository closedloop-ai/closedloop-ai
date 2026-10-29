import { describe, expect, it } from "vitest";
import { migrationDdl } from "./test-helpers/migration-index-ddl";

const RELATIONSHIP_ORDER_MIGRATION =
  "20261021150100_iss12650_artifact_link_child_order";
const RELATIONSHIP_ORDER_INDEX_MIGRATION =
  "20261021150200_iss12650_artifact_link_child_order_index";
const METADATA_BACKFILL_MIGRATION =
  "20261021150300_prd725_link_order_metadata_backfill";

describe("PRD-725 child order and verification migration", () => {
  it("moves child rank authority onto each parent relationship", () => {
    const ddl = migrationDdl(RELATIONSHIP_ORDER_MIGRATION);

    expect(ddl).toContain('ADD COLUMN "sort_order" INTEGER');
    expect(ddl).toContain(
      'PARTITION BY link."organization_id", link."source_id"'
    );
    expect(ddl).toContain('ORDER BY link."created_at", link."id"');
    expect(migrationDdl(RELATIONSHIP_ORDER_INDEX_MIGRATION)).toContain(
      'CREATE INDEX CONCURRENTLY "artifact_links_parent_rank_idx"'
    );
  });

  it("moves valid scaffold metadata ranks into the relationship column", () => {
    const ddl = migrationDdl(METADATA_BACKFILL_MIGRATION);

    expect(ddl).toContain("'{projectHierarchy,sortOrder}'");
    expect(ddl).toContain("jsonb_typeof");
    expect(ddl).toContain("BETWEEN -2147483648 AND 2147483647");
    expect(ddl).toContain('SET "sort_order" = metadata_ranks.sort_order');
    expect(ddl).not.toContain('UPDATE "artifacts"');
  });
});
