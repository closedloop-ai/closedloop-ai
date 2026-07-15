/**
 * @file sync-source-commit-refs.test.ts
 * @description FEA-2731 / PRD-510 D7 — the desktop sync source must emit a
 * `commit`-kind ref (into `artifactRefs`) for each local `artifacts(kind='commit')`
 * link, carrying the ABBREVIATED sha, observing branch, subject, timestamp, and
 * desktop-parsed LOC so the cloud CommitDetail SSOT can render branch commit
 * history with no GitHub App installed.
 *
 * It also proves commit refs are the LOWEST priority under the shared per-session
 * `MAX_SYNCED_ARTIFACT_REFS` cap: a commit-heavy session must never push a
 * load-bearing branch ref (which drives FR12 org visibility) out of the payload.
 *
 * Drives the real SQLite → `loadSyncedSessions` boundary, mirroring
 * sync-source-ref-caps.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  MAX_SYNCED_ARTIFACT_REFS,
  PR_INT_MAX,
} from "@repo/api/src/types/session-artifact-link";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// A session cwd of NULL short-circuits attribution resolution.
function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

async function seedCommitLink(
  db: DbRun,
  sessionId: string,
  index: number,
  overrides: {
    sha?: string;
    branchName?: string;
    title?: string | null;
    committedAt?: string | null;
    linesAdded?: number | null;
    linesRemoved?: number | null;
    filesChanged?: number | null;
    createdAt?: string;
  } = {}
): Promise<void> {
  const {
    // Must be valid 7–40 lowercase hex: the emitter drops any ref whose sha
    // fails COMMIT_SHA_PATTERN (see toSyncedCommitSha), so a non-hex placeholder
    // like "sha0001" would be silently omitted. `c0ffee` + a 2-hex-digit index
    // keeps each fixture sha distinct and valid.
    sha = `c0ffee${index.toString(16).padStart(2, "0")}`,
    branchName = "feat/x",
    title = `commit subject ${index}`,
    committedAt = "2026-07-10T00:00:00.000Z",
    linesAdded = null,
    linesRemoved = null,
    filesChanged = null,
    createdAt = `t-c-${String(index).padStart(4, "0")}`,
  } = overrides;
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, sha, branch_name, title, committed_at, lines_added, lines_removed, files_changed, created_at, last_seen_at)
     VALUES (?, ?, 'commit', 'acme/repo', ?, ?, ?, ?, ?, ?, ?, 't1', 't1')`,
    `art-c-${index}`,
    `commit:${index}`,
    sha,
    branchName,
    title,
    committedAt,
    linesAdded,
    linesRemoved,
    filesChanged
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES (?, ?, ?, 'created', 'git_command', '{}', 1, 't1', ?)`,
    `l-c-${index}`,
    sessionId,
    `art-c-${index}`,
    createdAt
  );
}

test("FEA-2731: a commit-kind link emits a commit ref with sha/branch/message/committedAt/LOC", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2731-commit-refs-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s1','completed')"
      );
      await seedCommitLink(db, "s1", 1, {
        sha: "1a2b3c4",
        branchName: "feat/x",
        title: "feat: add thing",
        committedAt: "2026-07-10T12:34:56.000Z",
        linesAdded: 10,
        linesRemoved: 2,
        filesChanged: 3,
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");

      const commitRef = session.artifactRefs?.find((r) => r.kind === "commit");
      assert.ok(commitRef, "a commit ref was emitted");
      if (commitRef.kind !== "commit") {
        assert.fail("expected a commit ref");
      }
      assert.equal(commitRef.repositoryFullName, "acme/repo");
      assert.equal(commitRef.branchName, "feat/x");
      assert.equal(commitRef.sha, "1a2b3c4");
      assert.equal(commitRef.message, "feat: add thing");
      assert.equal(commitRef.committedAt, "2026-07-10T12:34:56.000Z");
      assert.equal(commitRef.linesAdded, 10);
      assert.equal(commitRef.linesRemoved, 2);
      assert.equal(commitRef.filesChanged, 3);
      assert.equal(commitRef.relation, "created");
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3206: an out-of-int4 LOC count is dropped (would overflow commit_detail and abort the batch), while in-range counts survive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3206-commit-loc-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s5','completed')"
      );
      // linesAdded overflows int4 (a 64-bit SQLite value). Without the
      // nonNegativeInt() guard the desktop would pass it straight through and the
      // cloud `commit_detail` INTEGER write would 22003-overflow, aborting the
      // whole multi-session sync transaction. linesRemoved/filesChanged stay in
      // range and must still be emitted.
      await seedCommitLink(db, "s5", 1, {
        linesAdded: PR_INT_MAX + 1,
        linesRemoved: 7,
        filesChanged: 2,
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s5"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const commitRef = session.artifactRefs?.find((r) => r.kind === "commit");
      assert.ok(commitRef, "a commit ref was still emitted");
      if (commitRef.kind !== "commit") {
        assert.fail("expected a commit ref");
      }
      assert.equal(
        commitRef.linesAdded,
        undefined,
        "the out-of-int4 linesAdded is dropped before the wire"
      );
      assert.equal(
        commitRef.linesRemoved,
        7,
        "an in-range linesRemoved is preserved"
      );
      assert.equal(
        commitRef.filesChanged,
        2,
        "an in-range filesChanged is preserved"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2731: an unparseable committed_at is dropped, not emitted (never stalls the batch)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2731-commit-ts-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s3','completed')"
      );
      await seedCommitLink(db, "s3", 1, { committedAt: "not-a-date" });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s3"],
        emptyAttributionCache()
      );
      const commitRef = session?.artifactRefs?.find((r) => r.kind === "commit");
      assert.ok(commitRef, "a commit ref was still emitted");
      if (commitRef.kind !== "commit") {
        assert.fail("expected a commit ref");
      }
      assert.equal(
        commitRef.committedAt,
        undefined,
        "an unparseable committed_at is omitted"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2731: a malformed sha omits the whole commit ref (never poisons the batch parse)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2731-commit-sha-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s4','completed')"
      );
      // A non-hex local sha would fail the cloud's strict `commit`-kind parse and,
      // because the whole payload is validated in one pass, reject every session
      // in the tick. The desktop must drop it before it reaches the wire.
      await seedCommitLink(db, "s4", 1, { sha: "not-a-real-sha!" });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s4"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const commitRef = session.artifactRefs?.find((r) => r.kind === "commit");
      assert.equal(
        commitRef,
        undefined,
        "no commit ref is emitted for a malformed sha"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2731: commit refs never crowd a load-bearing branch ref out of the cap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2731-commit-priority-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const OVERSIZED_COMMITS = 150; // past the 100 cap on its own
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s2','completed')"
      );
      for (let i = 0; i < OVERSIZED_COMMITS; i++) {
        await seedCommitLink(db, "s2", i);
      }
      // One branch link, created LAST (latest created_at) so a naive
      // slice(0,100) of the oldest-first, commit-dominated array would drop it —
      // proving retention is by PRIORITY, not link order.
      await db.run(
        `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
         VALUES ('art-b','branch:1','branch','acme/repo','feat/x','t1','t1')`
      );
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ('l-b','s2','art-b','created','git_command','{}',1,'t1','t-z-branch')`
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s2"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.equal(
        session.artifactRefs?.length,
        MAX_SYNCED_ARTIFACT_REFS,
        "artifactRefs sliced to the shared cap"
      );
      const branchRef = session.artifactRefs?.find((r) => r.kind === "branch");
      assert.ok(
        branchRef,
        "the branch ref survives despite 150 competing commit refs"
      );
      const commitCount = session.artifactRefs?.filter(
        (r) => r.kind === "commit"
      ).length;
      assert.equal(
        commitCount,
        MAX_SYNCED_ARTIFACT_REFS - 1,
        "commits fill only the remaining budget after the branch ref"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
