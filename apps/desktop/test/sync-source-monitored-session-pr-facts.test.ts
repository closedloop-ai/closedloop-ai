import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { onTestFinished, test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

test("ISS-6060: a monitored PR keeps its bounded canonical facts", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss6060-activity-pr-sync-")
  );
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-08-12T12:30:00.000Z",
  });
  onTestFinished(() => db.close());
  const carrier = {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: [
      {
        kind: MonitoredSessionActivityEventKind.AgentAction,
        sourceEventId: "monitored_session_v1:pr-action",
        occurredAt: "2026-08-12T12:05:00.000Z",
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    ],
  };
  await db.run("INSERT INTO sessions (id, status) VALUES ('s-pr','inactive')");
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, branch_name, title,
        created_at, last_seen_at)
     VALUES
       ('pr-1','pr:iss6060','pull_request','closedloop-ai/closedloop-ai',6060,
        'feat/iss-6060','Monitor attributable Session activity','t1','t1')`
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES ('link-pr','s-pr','pr-1','created','pr_create_output',?,25,
             '2026-08-12T12:05:00.000Z','t2')`,
    JSON.stringify({ toolIndex: 0, monitoredSessionActivity: carrier })
  );
  await db.run(
    `INSERT INTO pull_requests
       (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
        closed_at, observed_at, created_at)
     VALUES
       ('pr-row','s-pr','https://github.com/closedloop-ai/closedloop-ai/pull/6060',
        6060,'closedloop-ai/closedloop-ai','feat/iss-6060',
        '2026-08-12T12:15:00.000Z',
        '2026-08-12T12:15:00.000Z','2026-08-12T12:15:00.000Z')`
  );

  const [session] = await db.syncSource.loadSyncedSessions(
    ["s-pr"],
    emptyAttributionCache(),
    { includeMonitoredSessionActivity: true }
  );
  const pr = session?.artifactRefs?.find(
    (ref) => ref.kind === ArtifactRefTargetKind.PullRequest
  );

  assert.ok(pr?.kind === ArtifactRefTargetKind.PullRequest);
  assert.deepEqual(pr.monitoredSessionActivity, carrier);
  assert.deepEqual(
    {
      title: pr.title,
      branchName: pr.branchName,
      closedAt: pr.closedAt,
    },
    {
      title: "Monitor attributable Session activity",
      branchName: "feat/iss-6060",
      closedAt: "2026-08-12T12:15:00.000Z",
    }
  );
  // The removed facts are omitted from the wire, not sent as undefined/null.
  for (const key of [
    "state",
    "isDraft",
    "additions",
    "deletions",
    "changedFiles",
    "mergedAt",
  ]) {
    assert.equal(key in pr, false, key);
  }
});

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}
