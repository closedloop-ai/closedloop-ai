import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { downgradeMonitoredSessionActivity } from "../src/main/database/synced-monitored-session-activity.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

test("ISS-6060: SQLite retains activity while sync projection follows negotiated capability", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss6060-activity-sync-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-12T12:30:00.000Z",
    });
    try {
      const carrier = {
        completeness: BranchActivityEvidenceCompleteness.Complete,
        events: [
          {
            kind: MonitoredSessionActivityEventKind.AgentAction,
            sourceEventId: "monitored_session_v1:stable-event",
            occurredAt: "2026-08-12T12:05:00.000Z",
            completeness: BranchActivityEvidenceCompleteness.Complete,
          },
        ],
      };
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s1','inactive')"
      );
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
         VALUES ('branch-1','branch:iss6060','branch','closedloop-ai/symphony-alpha','feat/iss-6060','t1','t1')`
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ('link-1','s1','branch-1','created','git_push',?,25,'2026-08-12T12:05:00.000Z','t2')`,
        JSON.stringify({ toolIndex: 0, monitoredSessionActivity: carrier })
      );

      const [legacy] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache(),
        { includeMonitoredSessionActivity: false }
      );
      const [capable] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache(),
        { includeMonitoredSessionActivity: true }
      );
      const legacyBranch = legacy?.artifactRefs?.find(
        (ref) => ref.kind === ArtifactRefTargetKind.Branch
      );
      const capableBranch = capable?.artifactRefs?.find(
        (ref) => ref.kind === ArtifactRefTargetKind.Branch
      );

      assert.ok(legacyBranch?.kind === ArtifactRefTargetKind.Branch);
      assert.equal(
        Object.hasOwn(legacyBranch, "monitoredSessionActivity"),
        false,
        "old-cloud projection omits only the optional carrier"
      );
      assert.ok(capableBranch?.kind === ArtifactRefTargetKind.Branch);
      assert.deepEqual(capableBranch.monitoredSessionActivity, carrier);
      const stored = await db.prisma.read((reader) =>
        reader.sessionArtifactLink.findUniqueOrThrow({
          where: { id: "link-1" },
          select: { evidence: true },
        })
      );
      assert.deepEqual(
        JSON.parse(stored.evidence).monitoredSessionActivity,
        carrier,
        "legacy projection never strips retained SQLite evidence"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-6060: parent ref truncation marks carrier and retained events partial", () => {
  const downgraded = downgradeMonitoredSessionActivity({
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    branchName: "feat/iss-6060",
    method: "git_push",
    relation: "created",
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: [
        {
          kind: MonitoredSessionActivityEventKind.AgentAction,
          sourceEventId: "monitored_session_v1:stable-event",
          occurredAt: "2026-08-12T12:05:00.000Z",
          completeness: BranchActivityEvidenceCompleteness.Complete,
        },
      ],
    },
  });

  assert.ok(downgraded.kind === ArtifactRefTargetKind.Branch);
  assert.equal(
    downgraded.monitoredSessionActivity?.completeness,
    BranchActivityEvidenceCompleteness.Partial
  );
  assert.equal(
    downgraded.monitoredSessionActivity?.events[0].completeness,
    BranchActivityEvidenceCompleteness.Partial
  );
});
