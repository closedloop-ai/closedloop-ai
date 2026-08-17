import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  MONITORED_ACTIVITY_TEST_ACTION_AT as ACTION_AT,
  MONITORED_ACTIVITY_TEST_BRANCH as BRANCH,
  makeMonitoredActivityTestSession as makeSession,
} from "./support/monitored-session-activity-fixtures.js";

test("ISS-6060: an activity-only ref persists privately without creating local membership", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss6060-activity-only-persistence-")
  );
  const db = await openTestDb(dir, {
    now: () => "2026-08-12T12:30:00.000Z",
  });
  try {
    const session = makeSession({
      endedAt: "2026-08-12T12:10:00.000Z",
      toolUses: [
        {
          id: "mcp-create-branch",
          name: "mcp__github__create_branch",
          timestamp: ACTION_AT,
          input: {
            owner: "closedloop-ai",
            repo: "symphony-alpha",
            branch: BRANCH,
          },
          output: { ref: `refs/heads/${BRANCH}` },
        },
      ],
    });

    const imported = await db.importer.importSession(session, "claude");
    assert.equal(imported.skipped, false);
    const [counts] = await db.prisma.client.$queryRawUnsafe<
      { artifacts: number | bigint; links: number | bigint }[]
    >(
      `SELECT
         (SELECT COUNT(*) FROM artifacts WHERE kind = 'branch') AS artifacts,
         (SELECT COUNT(*) FROM session_artifact_links WHERE session_id = $1) AS links`,
      session.sessionId
    );
    assert.ok(counts);
    assert.equal(Number(counts.artifacts), 0);
    assert.equal(Number(counts.links), 0);

    const [legacy] = await db.syncSource.loadSyncedSessions(
      [session.sessionId],
      emptyAttributionCache(),
      { includeMonitoredSessionActivity: false }
    );
    const [capable] = await db.syncSource.loadSyncedSessions(
      [session.sessionId],
      emptyAttributionCache(),
      { includeMonitoredSessionActivity: true }
    );
    assert.ok(legacy);
    assert.ok(capable);
    assert.equal(legacy.artifactRefs?.length ?? 0, 0);
    const activityRef = capable.artifactRefs?.find(
      (ref) => ref.kind === ArtifactRefTargetKind.Branch
    );
    assert.ok(activityRef?.kind === ArtifactRefTargetKind.Branch);
    assert.equal(activityRef.monitoredActivityOnly, true);
    assert.equal(activityRef.branchName, BRANCH);
    assert.equal(
      activityRef.monitoredSessionActivity?.events[0]?.occurredAt,
      ACTION_AT
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}
