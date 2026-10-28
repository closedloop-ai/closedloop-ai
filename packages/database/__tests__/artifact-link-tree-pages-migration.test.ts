import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const statements = readFileSync(
  new URL(
    "../prisma/migrations/20260918180000_add_artifact_link_tree_pages/migration.sql",
    import.meta.url
  ),
  "utf8"
).split(";");

describe("artifact tree continuation migration", () => {
  it("keys pages by snapshot/offset and indexes scope and expiry", () => {
    const table = statements.find((sql) =>
      sql.includes('CREATE TABLE "artifact_link_tree_pages"')
    );
    expect(table).toContain('PRIMARY KEY ("snapshot_id","offset")');
    expect(table).toContain('"link_ids" UUID[] NOT NULL');
    const indexes = statements.filter((sql) => sql.includes("CREATE INDEX"));
    expect(indexes).toHaveLength(2);
    expect(
      indexes.some((sql) =>
        sql.includes(
          '("organization_id", "query_key", "offset", "created_at" DESC)'
        )
      )
    ).toBe(true);
    expect(indexes.some((sql) => sql.includes('("expires_at")'))).toBe(true);
    const foreignKey = statements.find((sql) => sql.includes("ADD CONSTRAINT"));
    expect(foreignKey).toContain(
      'FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE'
    );
  });
});
