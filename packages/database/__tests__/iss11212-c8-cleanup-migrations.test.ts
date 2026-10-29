import { describe, expect, it } from "vitest";
import {
  migrationDdl,
  TRANSACTION_WRAP_TRIGGER_G,
} from "./test-helpers/migration-index-ddl";

/**
 * ISS-11212 (PLN-2120 Step 6): the DDL of the cleanup migrations, statement by
 * statement. What they do to rows is in
 * `integration/iss11212-c8-cleanup-migrations.integration.test.ts`.
 */
const ARTIFACT_REQUIRED =
  "20261006120100_iss11212_comment_thread_artifact_required";
const DROP_BRIDGES = "20261006120300_iss11212_drop_comment_bridges";
const DROP_INDEX = "20261006120400_iss11212_drop_superseded_reconcile_index";

const WHITESPACE_G = /\s+/g;

/** The migration's statements, comments stripped and whitespace collapsed. */
function statements(migration: string): string[] {
  return migrationDdl(migration)
    .split(";")
    .map((statement) => statement.replaceAll(WHITESPACE_G, " ").trim())
    .filter((statement) => statement.length > 0);
}

describe("comment_threads.artifact_id becomes NOT NULL", () => {
  it("adds the rule as a NOT VALID CHECK, validates it, then sets the column and drops the CHECK", () => {
    const ddl = statements(ARTIFACT_REQUIRED).filter((statement) =>
      statement.startsWith("ALTER TABLE")
    );

    expect(ddl).toEqual([
      'ALTER TABLE "comment_threads" DROP CONSTRAINT IF EXISTS "comment_threads_artifact_id_not_null", ADD CONSTRAINT "comment_threads_artifact_id_not_null" CHECK ("artifact_id" IS NOT NULL) NOT VALID',
      'ALTER TABLE "comment_threads" VALIDATE CONSTRAINT "comment_threads_artifact_id_not_null"',
      'ALTER TABLE "comment_threads" ALTER COLUMN "artifact_id" SET NOT NULL',
      'ALTER TABLE "comment_threads" DROP CONSTRAINT IF EXISTS "comment_threads_artifact_id_not_null"',
    ]);
  });

  it("carries nothing that makes Prisma wrap the file in one transaction", () => {
    // Split, each statement commits on its own, so the scan in VALIDATE does
    // not run under the ACCESS EXCLUSIVE lock ADD CONSTRAINT takes.
    expect(
      migrationDdl(ARTIFACT_REQUIRED).match(TRANSACTION_WRAP_TRIGGER_G)
    ).toBeNull();
  });

  it("bounds its lock waits and resets the bound", () => {
    const all = statements(ARTIFACT_REQUIRED);
    expect(all[0]).toBe("SET lock_timeout = '5s'");
    expect(all.at(-1)).toBe("RESET lock_timeout");
  });
});

describe("the ISS-11212 rolling-deploy bridges are dropped", () => {
  it("drops each trigger before the function it executes, and every function", () => {
    expect(statements(DROP_BRIDGES)).toEqual([
      "SET lock_timeout = '5s'",
      'DROP TRIGGER IF EXISTS "comments_iss11212_body_format_bridge" ON "comments"',
      'DROP FUNCTION IF EXISTS "iss11212_comments_body_format_bridge"()',
      'DROP TRIGGER IF EXISTS "comment_threads_iss11212_anchor_bridge" ON "comment_threads"',
      'DROP FUNCTION IF EXISTS "iss11212_comment_threads_anchor_bridge"()',
      'DROP TRIGGER IF EXISTS "github_comment_thread_projections_iss11212_anchor_bridge" ON "github_comment_thread_projections"',
      'DROP FUNCTION IF EXISTS "iss11212_github_thread_anchor_bridge"()',
      'DROP FUNCTION IF EXISTS "iss11212_github_thread_anchor"("github_comment_thread_projections", text)',
      "RESET lock_timeout",
    ]);
  });
});

describe("the superseded comment-reconcile index is dropped", () => {
  it("drops it alone, idempotently, with its lock wait bounded", () => {
    expect(statements(DROP_INDEX)).toEqual([
      "SET lock_timeout = '5s'",
      'DROP INDEX IF EXISTS "pull_request_detail_pr_state_comments_reconciled_at_idx"',
      "RESET lock_timeout",
    ]);
  });
});
