/**
 * @file component-invocations-default-branch-evidence.test.ts
 * @description Raw branch observations remain available to invocation
 * materialization even when the observed name resembles a conventional default.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
  makeInvocationSyncDir,
  NOW,
  openDb,
} from "./helpers/invocation-sync-fixtures.js";
import { staleRebuildFromStoredRows } from "./helpers/stored-rebuild.js";
import { makeSession } from "./normalized-session-test-utils.js";

const REPOSITORY_FULL_NAME = "closedloop-ai/symphony-alpha";

test("materialization retains a default-looking created-branch observation", async () => {
  const dir = await makeInvocationSyncDir("aci-default-branch-evidence-");
  const db = await openDb(dir);
  try {
    const sessionId = "session-default-branch-evidence";
    const invokedAt = "2026-07-22T10:00:00-05:00";
    await db.importer.importSession(
      makeSession({
        sessionId,
        startedAt: NOW,
        endedAt: "2026-07-22T17:05:00.000Z",
        toolUses: [
          {
            id: "toolu_default_branch_evidence",
            name: "Read",
            timestamp: invokedAt,
          },
        ],
      }),
      "claude"
    );
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name,
          created_at, last_seen_at)
       VALUES ($1, $2, 'branch', $3, 'main', $4, $4)`,
      "artifact-default-branch-evidence",
      `branch:${REPOSITORY_FULL_NAME}:main`,
      REPOSITORY_FULL_NAME,
      NOW
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, 'created', 'git_push', '{}', 1, $4, $5)`,
      "link-default-branch-evidence",
      sessionId,
      "artifact-default-branch-evidence",
      invokedAt,
      NOW
    );

    assert.equal(
      (await staleRebuildFromStoredRows(db, sessionId)).rebuilt,
      true
    );
    const rows = await db.prisma.client.$queryRawUnsafe<
      { git_branch: string | null; repository_full_name: string | null }[]
    >(
      `SELECT git_branch, repository_full_name
         FROM agent_component_invocations
        WHERE session_id = $1 AND component_kind = 'tool'`,
      sessionId
    );
    assert.deepEqual(rows, [
      {
        git_branch: "main",
        repository_full_name: REPOSITORY_FULL_NAME,
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
