/**
 * @file sync-source-branch-participation.test.ts
 * @description FEA-3821 — desktop sync emits explicit branch participation for
 * write-evidence branch refs while omitting it for read/workspace refs.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

test("FEA-3821: branch write links emit explicit wrote participation, read links omit it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3821-branch-part-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-23T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s1','completed')"
      );
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
         VALUES ('art-w','branch:w','branch','acme/repo','feat/wrote','t1','t1'),
                ('art-r','branch:r','branch','acme/repo','feat/read','t1','t1')`
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ('l-w','s1','art-w','created','git_commit','{}',1,'2026-07-23T01:00:00.000Z','t2'),
                ('l-r','s1','art-r','workspace','git_checkout','{}',1,'2026-07-23T01:05:00.000Z','t3')`
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");

      const branchRefs =
        session.artifactRefs?.filter(
          (ref) => ref.kind === ArtifactRefTargetKind.Branch
        ) ?? [];
      const wroteRef = branchRefs.find(
        (ref) =>
          ref.kind === ArtifactRefTargetKind.Branch &&
          ref.branchName === "feat/wrote"
      );
      const readRef = branchRefs.find(
        (ref) =>
          ref.kind === ArtifactRefTargetKind.Branch &&
          ref.branchName === "feat/read"
      );

      assert.ok(wroteRef, "write branch ref emitted");
      assert.ok(readRef, "read branch ref emitted");
      assert.equal(wroteRef.branchParticipation, BranchParticipationKind.Wrote);
      assert.equal(
        Object.hasOwn(readRef, "branchParticipation"),
        false,
        "read/workspace branch refs omit explicit participation"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
