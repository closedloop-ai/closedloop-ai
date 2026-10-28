/**
 * @file sync-source-repo-full-name-bound.test.ts
 * @description ISS-8882 §1 — the desktop sync source must not emit a branch,
 * pull_request, or commit `artifactRefs` entry (nor a `prRefs` entry) whose
 * stored `repo_full_name` exceeds `REPOSITORY_FULL_NAME_MAX_LENGTH`.
 *
 * `repositoryFullName` is a REQUIRED `.max(200)` field on every ref schema and
 * the cloud validates a whole batch (up to 200 sessions) with ONE parse, so a
 * single over-long slug rejects every session in the batch — deterministically,
 * so each retry re-fails. The two producers (`normalizeRepoFullName`, prose PR
 * mentions) are bounded here too, but rows written before that bound landed are
 * already in SQLite; the emitter guard is what stops a stored row from wedging
 * sync, and only a test that drives the real SQLite → `loadSyncedSessions`
 * projection can pin it.
 *
 * The exactly-at-the-bound fixture is load-bearing in the other direction: it is
 * the case that fails if the comparison is tightened or the bound shrinks. And
 * the sibling refs on the same session prove the DROP is per ref, not per
 * session.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArtifactRefTargetKind,
  REPOSITORY_FULL_NAME_MAX_LENGTH,
  SYNCED_PR_URL_MAX_LENGTH,
} from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import { findProsePrMentions } from "../src/main/collectors/parsing/artifact-ref-prose-refs.js";
import { normalizeRepoFullName } from "../src/main/database/db-helpers.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

// A session cwd of NULL short-circuits attribution resolution.
function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

const OWNER = "acme/";
/** Exactly at the bound — must still sync. */
const AT_BOUND_REPO =
  OWNER + "a".repeat(REPOSITORY_FULL_NAME_MAX_LENGTH - OWNER.length);
/** One character past the bound — must be dropped. */
const OVER_BOUND_REPO =
  OWNER + "b".repeat(REPOSITORY_FULL_NAME_MAX_LENGTH + 1 - OWNER.length);
/** The ticket's triggering shape: a 205-char slug. */
const LONG_REPO = `${"a".repeat(200)}/repo`;
const SHORT_REPO = "acme/repo";

type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

async function seedLink(
  db: DbRun,
  id: string,
  kind: "branch" | "pull_request" | "commit",
  repo: string,
  prUrl = `https://github.com/${repo}/pull/7`
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, branch_name, pr_number, url, sha, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 't1', 't1')`,
    `art-${id}`,
    `${kind}:${id}`,
    kind,
    repo,
    kind === "pull_request" ? null : "feat/ok",
    kind === "pull_request" ? 7 : null,
    kind === "pull_request" ? prUrl : null,
    kind === "commit" ? `c0ffee${id.length.toString().padStart(2, "0")}` : null
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES (?, 's1', ?, 'created', 'git_command', '{}', 1, 't1', ?)`,
    `l-${id}`,
    `art-${id}`,
    `t-${id}`
  );
}

async function loadRepoNames(repos: readonly string[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8882-repo-bound-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s1','inactive')"
      );
      let n = 0;
      for (const repo of repos) {
        for (const kind of ["branch", "pull_request", "commit"] as const) {
          n += 1;
          await seedLink(db, `${kind}-${n}`, kind, repo);
        }
      }
      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      if (!session) {
        throw new Error("session did not hydrate");
      }
      const refs = session.artifactRefs ?? [];
      const byKind = (kind: ArtifactRefTargetKind) =>
        refs
          .filter((ref) => ref.kind === kind)
          .map((ref) =>
            "repositoryFullName" in ref ? ref.repositoryFullName : ""
          )
          .sort();
      return {
        branch: byKind(ArtifactRefTargetKind.Branch),
        pullRequest: byKind(ArtifactRefTargetKind.PullRequest),
        commit: byKind(ArtifactRefTargetKind.Commit),
        prRefs: (session.prRefs ?? [])
          .map((ref) => ref.repositoryFullName)
          .sort(),
      };
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ISS-8882: a 205-char stored repo_full_name drops only its own ref on every arm; siblings still emit", async () => {
  const out = await loadRepoNames([SHORT_REPO, LONG_REPO]);
  assert.deepEqual(out.branch, [SHORT_REPO]);
  assert.deepEqual(out.pullRequest, [SHORT_REPO]);
  assert.deepEqual(out.commit, [SHORT_REPO]);
  assert.deepEqual(out.prRefs, [SHORT_REPO]);
});

test("ISS-8882: a slug exactly at the bound syncs unchanged; one past it does not", async () => {
  const out = await loadRepoNames([AT_BOUND_REPO, OVER_BOUND_REPO]);
  for (const arm of [out.branch, out.pullRequest, out.commit, out.prRefs]) {
    // A truncating emitter would pass a "no over-bound name" check with a slug
    // the local store never observed, so pin the exact surviving value.
    assert.deepEqual(arm, [AT_BOUND_REPO]);
  }
});

test("ISS-8882: normalizeRepoFullName rejects a slug past the wire bound and keeps one at it", () => {
  assert.equal(normalizeRepoFullName(AT_BOUND_REPO), AT_BOUND_REPO);
  assert.equal(normalizeRepoFullName(OVER_BOUND_REPO), null);
  assert.equal(normalizeRepoFullName(LONG_REPO), null);
});

test("ISS-8882: a prose PR mention qualified by a 205-char slug yields no mention", () => {
  assert.deepEqual(
    findProsePrMentions([`Opened PR ${LONG_REPO}#7 today.`]),
    []
  );
  assert.deepEqual(
    findProsePrMentions([`Opened PR ${AT_BOUND_REPO}#7 today.`]),
    [{ prNumber: 7, repoFullName: AT_BOUND_REPO }]
  );
});

const PR_URL_PREFIX = `https://github.com/${SHORT_REPO}/pull/`;
/** Exactly at the prUrl bound — must ride the prRef verbatim. */
const AT_BOUND_PR_URL =
  PR_URL_PREFIX + "7".repeat(SYNCED_PR_URL_MAX_LENGTH - PR_URL_PREFIX.length);
/** One character past it — the prRef still syncs, without a prUrl. */
const OVER_BOUND_PR_URL = `${AT_BOUND_PR_URL}7`;

test("ISS-8882: an over-bound stored url drops only prUrl; the prRef itself and an at-bound url survive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8882-prurl-bound-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('s1','inactive')"
      );
      await seedLink(db, "pr-at", "pull_request", SHORT_REPO, AT_BOUND_PR_URL);
      await seedLink(
        db,
        "pr-over",
        "pull_request",
        "acme/other",
        OVER_BOUND_PR_URL
      );
      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      if (!session) {
        throw new Error("session did not hydrate");
      }
      const prRefs = [...(session.prRefs ?? [])].sort((a, b) =>
        a.repositoryFullName.localeCompare(b.repositoryFullName)
      );
      assert.deepEqual(
        prRefs.map((ref) => [ref.repositoryFullName, ref.prUrl]),
        [
          ["acme/other", undefined],
          [SHORT_REPO, AT_BOUND_PR_URL],
        ]
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
