import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const statements = readFileSync(
  new URL(
    "../prisma/migrations/20261006232050_iss12048_feature_flag_snapshots/migration.sql",
    import.meta.url
  ),
  "utf8"
).split(";");

describe("ISS-12048 feature flag snapshots migration", () => {
  it("creates one keyed table and nothing else", () => {
    const table = statements.find((sql) =>
      sql.includes('CREATE TABLE "feature_flag_snapshots"')
    );
    expect(table).toContain(
      'CONSTRAINT "feature_flag_snapshots_pkey" PRIMARY KEY ("id")'
    );
    expect(table).toContain('"flags" JSONB NOT NULL');
    expect(table).toContain('"org_id" TEXT,');
    expect(statements.some((sql) => sql.includes("CREATE INDEX"))).toBe(false);
    expect(statements.some((sql) => sql.includes("ALTER TABLE"))).toBe(false);
  });
});
