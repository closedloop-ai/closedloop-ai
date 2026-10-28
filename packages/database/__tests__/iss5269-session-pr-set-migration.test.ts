import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationName = "20260817203000_iss5269_guard_multi_session_pr_metadata";
const migrationSql = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    migrationName,
    "migration.sql"
  ),
  "utf8"
);

describe(`${migrationName} DDL`, () => {
  it("adds the canonical classifier, preflight, and scalar-kind constraint", () => {
    expect(migrationSql).toContain(
      'CREATE OR REPLACE FUNCTION "artifact_links_has_canonical_multi_pr_refs"'
    );
    expect(migrationSql).toContain("FROM jsonb_array_elements(refs) AS entry");
    expect(migrationSql).toContain(
      "ISS-5269 preflight: canonical multi-PR rows still use scalar session_pr"
    );
    expect(migrationSql).toContain(
      'ADD CONSTRAINT "artifact_links_session_pr_set_kind_check"'
    );
    expect(migrationSql).toContain(
      "NOT \"artifact_links_has_canonical_multi_pr_refs\"(metadata -> 'prRefs')"
    );
    expect(migrationSql).toContain(
      "COALESCE(metadata ->> 'linkKind', '') <> 'session_pr'"
    );
  });
});
