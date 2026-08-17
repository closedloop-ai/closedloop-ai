import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DefinitionVersionEditorRole,
  SourceOccurrenceType,
} from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";

// FEA-3982 (PLN-1494 Slice 1 + Mike-approved edit-lineage capture): per-migration
// DDL contract guard for (a) the four new `source_occurrence_type` enum values
// and (b) the additive `definition_version_editors` lineage table + role enum.
// This is a per-migration migration.sql DDL guard (allowed): it asserts THIS
// migration's specific ALTER TYPE / CREATE TABLE clauses, not the whole
// schema.prisma.

const MIGRATION_DIR =
  "20260724010300_fea3982_source_occurrence_types_and_version_editors";
const MIGRATION_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "prisma",
    "migrations",
    MIGRATION_DIR,
    "migration.sql"
  ),
  "utf8"
);

// The four NEW occurrence-type values (the FEA-3290 trio is NOT re-added).
const NEW_OCCURRENCE_TYPES = [
  SourceOccurrenceType.StaticFile,
  SourceOccurrenceType.Distributed,
  SourceOccurrenceType.BuiltinClaude,
  SourceOccurrenceType.BuiltinCodex,
] as const;

const PRESERVED_OCCURRENCE_TYPES = [
  SourceOccurrenceType.Repository,
  SourceOccurrenceType.Local,
  SourceOccurrenceType.Pack,
] as const;

// Destructive DDL only — a leading DROP TABLE/COLUMN/TYPE/INDEX statement, not
// the word "drop" in the migration's rollback-notes comment.
const DROP_DDL_RE = /^\s*DROP\s+(TABLE|COLUMN|TYPE|INDEX)/im;
const ROLE_DEFAULT_EDITOR_RE =
  /"role"\s+"definition_version_editor_role"\s+NOT NULL DEFAULT 'editor'/;
const VERSION_FK_CASCADE_RE =
  /"definition_version_editors_definition_version_id_fkey"[\s\S]*?REFERENCES "definition_versions"\("id"\) ON DELETE CASCADE/;
const USER_FK_CASCADE_RE =
  /"definition_version_editors_user_id_fkey"[\s\S]*?REFERENCES "users"\("id"\) ON DELETE CASCADE/;

describe(`${MIGRATION_DIR} DDL contract`, () => {
  it("adds exactly the four new source_occurrence_type values via ADD VALUE (additive)", () => {
    for (const value of NEW_OCCURRENCE_TYPES) {
      expect(MIGRATION_SQL).toContain(
        `ALTER TYPE "source_occurrence_type" ADD VALUE '${value}'`
      );
    }
    // Additive-only: the FEA-3290 values are never re-declared or dropped in
    // this migration (they already exist; re-adding would error).
    for (const preserved of PRESERVED_OCCURRENCE_TYPES) {
      expect(MIGRATION_SQL).not.toContain(`ADD VALUE '${preserved}'`);
    }
    expect(MIGRATION_SQL).not.toMatch(DROP_DDL_RE);
  });

  it("creates the definition_version_editor_role enum with both roles", () => {
    expect(MIGRATION_SQL).toContain(
      `CREATE TYPE "definition_version_editor_role" AS ENUM ('${DefinitionVersionEditorRole.Discoverer}', '${DefinitionVersionEditorRole.Editor}')`
    );
  });

  it("creates the definition_version_editors table with a (version, user) unique key and cascading FKs", () => {
    expect(MIGRATION_SQL).toContain(
      'CREATE TABLE "definition_version_editors"'
    );
    // The lineage identity: one row per (version, user).
    expect(MIGRATION_SQL).toContain(
      'CREATE UNIQUE INDEX "definition_version_editors_definition_version_id_user_id_key" ON "definition_version_editors"("definition_version_id", "user_id")'
    );
    // role defaults to editor (discoverer is derived at read time).
    expect(MIGRATION_SQL).toMatch(ROLE_DEFAULT_EDITOR_RE);
    // Both FKs cascade so a purged version/user never orphans a lineage row.
    expect(MIGRATION_SQL).toMatch(VERSION_FK_CASCADE_RE);
    expect(MIGRATION_SQL).toMatch(USER_FK_CASCADE_RE);
  });
});
