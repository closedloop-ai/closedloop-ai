/**
 * @file sync-source-pr-filter.test.ts
 * @description FEA-2806 — the desktop sync source's `pullRequestRows` query must
 * include PRs with `method = 'harness_pr_link'` (the session's actual PR work)
 * regardless of relation, while excluding `pr_url_in_tool_use` noise PRs that
 * have `relation = 'referenced'`.
 *
 * Drives the real SQLite → `loadSyncedSessions` boundary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

type DbRun = { run(sql: string, ...params: unknown[]): Promise<void> };

async function seedPrArtifactLink(
  db: DbRun,
  sessionId: string,
  opts: {
    prNumber: number;
    repoFullName?: string;
    relation: string;
    method: string;
    title?: string | null;
    prState?: string | null;
  }
): Promise<void> {
  const {
    prNumber,
    repoFullName = "acme/repo",
    relation,
    method,
    title = `PR #${prNumber}`,
    prState = null,
  } = opts;
  const artifactId = `art-pr-${repoFullName}-${prNumber}`;
  const identityKey = `pull_request:${repoFullName}#${prNumber}`;
  const linkId = `${sessionId}:${artifactId}:${relation}:${method}`;
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, title, pr_state,
        harness, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, 'claude', 't1', 't1', 't1')
     ON CONFLICT(identity_key) DO NOTHING`,
    artifactId,
    identityKey,
    repoFullName,
    prNumber,
    title,
    prState
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, '{}', 0, 'candidate', 1, 't1', 't1')
     ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
    linkId,
    sessionId,
    artifactId,
    relation,
    method
  );
}

test("FEA-2806: harness_pr_link referenced PR appears in synced session prs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2806-pr-filter-"));
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
      await seedPrArtifactLink(db, "s1", {
        prNumber: 2353,
        repoFullName: "closedloop-ai/symphony-alpha",
        relation: "referenced",
        method: "harness_pr_link",
        prState: "MERGED",
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.ok(session.prs, "prs field populated");
      assert.equal(session.prs.length, 1, "exactly 1 PR in prs");
      assert.equal(session.prs[0].num, 2353);
      assert.equal(
        session.prs[0].status,
        "merged",
        "harness_pr_link PR with MERGED state surfaces lifecycle status"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("FEA-2806: pr_url_in_tool_use referenced PR excluded from synced session prs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2806-pr-noise-"));
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
      await seedPrArtifactLink(db, "s1", {
        prNumber: 999,
        relation: "referenced",
        method: "pr_url_in_tool_use",
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.equal(
        session.prs?.length ?? 0,
        0,
        "noise referenced PR excluded from prs"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("FEA-2806: created relation PR still appears in synced session prs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea2806-pr-created-"));
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
      await seedPrArtifactLink(db, "s1", {
        prNumber: 100,
        relation: "created",
        method: "pr_create_output",
      });

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.ok(session.prs, "prs field populated");
      assert.equal(session.prs.length, 1, "created PR still surfaces");
      assert.equal(session.prs[0].num, 100);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true });
  }
});
