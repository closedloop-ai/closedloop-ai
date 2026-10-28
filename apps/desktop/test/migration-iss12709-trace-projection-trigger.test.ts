import assert from "node:assert/strict";
import { test } from "vitest";
import { openTestPrisma } from "./prisma-test-utils.js";

const ARTIFACT_UPDATE_TRIGGER =
  "invalidate_session_list_trace_projection_artifact_update";
const DROPPED_COLUMN_NAMES = [
  "pr_state",
  "lines_added",
  "lines_removed",
  "files_changed",
  "head_sha",
  "merge_commit_sha",
  "github_head_branch",
];

test("ISS-12709: the migrated store keeps one artifact-update trigger that names no dropped column, and no pr_status trigger", async () => {
  const { db, close } = await openTestPrisma();
  try {
    const triggers = await db.query<{ name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'"
    );

    const artifactUpdate = triggers.rows.filter(
      (row) => row.name === ARTIFACT_UPDATE_TRIGGER
    );
    assert.equal(artifactUpdate.length, 1);
    for (const column of DROPPED_COLUMN_NAMES) {
      assert.equal(
        artifactUpdate[0].sql.includes(column),
        false,
        `${ARTIFACT_UPDATE_TRIGGER} still names ${column}`
      );
    }

    assert.deepEqual(
      triggers.rows
        .map((row) => row.name)
        .filter((name) => name.includes("pr_status")),
      []
    );
  } finally {
    await close();
  }
});
