import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const statements = readFileSync(
  new URL(
    "../prisma/migrations/20261014212709_document_unified_comments/migration.sql",
    import.meta.url
  ),
  "utf8"
).split(";");

function statement(marker: string): string | undefined {
  return statements.find((sql) => sql.includes(marker));
}

describe("ISS-11216 document unified comments migration", () => {
  it("creates the reanchor mode enum", () => {
    expect(statement('CREATE TYPE "CommentReanchorMode"')).toContain(
      "AS ENUM ('MISSING', 'FULL')"
    );
  });

  it("adds only nullable storage columns to comment attachments", () => {
    const alter = statement('ALTER TABLE "comment_attachments"');
    expect(alter).toContain('ADD COLUMN     "bucket" TEXT,');
    expect(alter).toContain('ADD COLUMN     "key" TEXT,');
    expect(alter).toContain('ADD COLUMN     "uploaded_at" TIMESTAMP(3)');
    expect(alter).not.toContain("NOT NULL");
  });

  it("keys one reanchor request per document, due-ordered", () => {
    expect(
      statement(
        'CREATE UNIQUE INDEX IF NOT EXISTS "comment_reanchor_requests_artifact_id_key"'
      )
    ).toContain('ON "comment_reanchor_requests"("artifact_id")');
    expect(
      statement(
        'CREATE INDEX IF NOT EXISTS "comment_reanchor_requests_next_attempt_at_idx"'
      )
    ).toContain('ON "comment_reanchor_requests"("next_attempt_at")');
  });

  it("cascades the reanchor queue off its owners", () => {
    for (const constraint of [
      "comment_reanchor_requests_organization_id_fkey",
      "comment_reanchor_requests_artifact_id_fkey",
    ]) {
      expect(statement(`ADD CONSTRAINT "${constraint}"`)).toContain(
        "ON DELETE CASCADE"
      );
    }
  });
});
