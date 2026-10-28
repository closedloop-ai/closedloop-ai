/**
 * @file sync-source-branch-name-bound.test.ts
 * @description ISS-8529 Section 2 — the desktop sync source must not emit a
 * branch-kind or commit-kind `artifactRefs` entry whose stored `branch_name`
 * exceeds `BRANCH_NAME_MAX_LENGTH`.
 *
 * `branchName` is a REQUIRED `.max(300)` field on both wire schemas and the
 * cloud validates a whole batch (up to 200 sessions) with ONE parse, so a single
 * oversized name rejects every session in the batch — deterministically, so each
 * retry re-fails. `isValidBranchName` now bounds fresh extraction, but rows
 * written before that bound landed are already in SQLite; these emitter guards
 * are what stops a stored row from wedging sync, and only a test that drives the
 * real SQLite → `loadSyncedSessions` projection can pin them. The
 * branch-validation suite exercises extraction only and stays green if either
 * guard here is deleted.
 *
 * The exactly-at-the-bound fixture is load-bearing in the other direction: it is
 * the case that fails if the comparison is tightened to `<` or the bound is
 * swapped for a smaller literal.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// A session cwd of NULL short-circuits attribution resolution.
function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

const BRANCH_PREFIX = "feat/";
/** Exactly at the bound — must still sync. */
const AT_BOUND_BRANCH =
  BRANCH_PREFIX + "a".repeat(BRANCH_NAME_MAX_LENGTH - BRANCH_PREFIX.length);
/** One character past the bound — must be dropped. */
const OVER_BOUND_BRANCH = "z".repeat(BRANCH_NAME_MAX_LENGTH + 1);
const SHORT_BRANCH = "feat/ok";

type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

async function seedBranchLink(
  db: DbRun,
  id: string,
  branchName: string,
  createdAt: string
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES (?, ?, 'branch', 'acme/repo', ?, 't1', 't1')`,
    `art-${id}`,
    `branch:${id}`,
    branchName
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES (?, 's1', ?, 'created', 'git_commit', '{}', 1, 't1', ?)`,
    `l-${id}`,
    `art-${id}`,
    createdAt
  );
}

async function seedCommitLink(
  db: DbRun,
  id: string,
  branchName: string,
  sha: string,
  createdAt: string
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, sha, branch_name, title, committed_at, created_at, last_seen_at)
     VALUES (?, ?, 'commit', 'acme/repo', ?, ?, ?, '2026-07-10T00:00:00.000Z', 't1', 't1')`,
    `art-${id}`,
    `commit:${id}`,
    sha,
    branchName,
    `commit subject ${id}`
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES (?, 's1', ?, 'created', 'git_command', '{}', 1, 't1', ?)`,
    `l-${id}`,
    `art-${id}`,
    createdAt
  );
}

test("ISS-8529: a stored over-bound branch_name drops only its own ref, branch and commit alike", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8529-branch-bound-"));
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
      await seedBranchLink(db, "b-short", SHORT_BRANCH, "t-b-0001");
      await seedBranchLink(db, "b-at", AT_BOUND_BRANCH, "t-b-0002");
      await seedBranchLink(db, "b-over", OVER_BOUND_BRANCH, "t-b-0003");
      await seedCommitLink(db, "c-short", SHORT_BRANCH, "c0ffee01", "t-c-0001");
      await seedCommitLink(
        db,
        "c-over",
        OVER_BOUND_BRANCH,
        "c0ffee02",
        "t-c-0002"
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const refs = session.artifactRefs ?? [];

      const branchNames = refs
        .filter((ref) => ref.kind === ArtifactRefTargetKind.Branch)
        .map((ref) => ref.branchName);
      assert.deepEqual(
        [...branchNames].sort(),
        [AT_BOUND_BRANCH, SHORT_BRANCH].sort(),
        "the over-bound branch ref is dropped; the at-bound one still syncs"
      );

      const commitShas = refs
        .filter((ref) => ref.kind === ArtifactRefTargetKind.Commit)
        .map((ref) => ref.sha);
      assert.deepEqual(
        commitShas,
        ["c0ffee01"],
        "the commit ref observing an over-bound branch is dropped whole, its sibling kept"
      );

      // The drop is the point, so prove no surviving ref carries the bad name —
      // an emitter that truncated instead of dropping would pass the two
      // assertions above with a name the local store never observed.
      assert.equal(
        refs.some(
          (ref) =>
            (ref.kind === ArtifactRefTargetKind.Branch ||
              ref.kind === ArtifactRefTargetKind.Commit) &&
            ref.branchName.length > BRANCH_NAME_MAX_LENGTH
        ),
        false,
        "no emitted ref carries a branch name past the bound"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
