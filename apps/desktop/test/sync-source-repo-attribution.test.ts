/**
 * @file sync-source-repo-attribution.test.ts
 * @description FEA-3555 (repo/diff slice) — the DESKTOP_SYNC repo attribution
 * for a session must survive worktree deletion.
 *
 * Root cause: `resolveSessionAttributionAsync` re-derives `repositoryFullName`
 * at sync time by running `git remote get-url origin` in the session's live
 * worktree. For an old completed session whose worktree was later deleted the
 * live lookup returns null, so the session used to lose its repo (and the
 * repo-scoped diff/lines) attribution on every sync.
 *
 * The fix persists the live-resolved repo name onto the `sessions.repo_full_name`
 * column (a durable cache) and falls back to it when the live lookup fails.
 *
 * This suite drives the real SQLite -> `loadSyncedSessions` boundary and a real
 * temp git repo, mirroring sync-source-commit-refs.test.ts.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "../src/main/session/shared-agent-sessions-api.js";
import {
  emptyAttributionCache,
  initGitRepoWithOrigin,
} from "./attribution-test-helpers.js";

/** Read the persisted repo_full_name for a session row (the durable cache). */
async function readStoredRepoFullName(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string
): Promise<string | null> {
  const row = await db.prisma.read((reader) =>
    reader.session.findUnique({
      where: { id: sessionId },
      select: { repoFullName: true },
    })
  );
  return row?.repoFullName ?? null;
}

test("FEA-3555: a live-resolved repo name is written back to sessions.repo_full_name", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3555-writeback-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const worktree = path.join(dir, "wt");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await mkdir(worktree, { recursive: true });
      initGitRepoWithOrigin(worktree, "acme/live-repo");
      await db.run(
        "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ('s1','completed',?,NULL)",
        worktree
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.equal(
        session.attribution?.repositoryFullName,
        "acme/live-repo",
        "the live git remote resolves the repo full name"
      );

      // The durable cache column is now populated from the live resolution.
      assert.equal(
        await readStoredRepoFullName(db, "s1"),
        "acme/live-repo",
        "the resolved repo name is persisted onto the session row"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3555: when the worktree is gone, attribution falls back to the stored repo name", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3555-fallback-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  // A cwd that is NOT a git repo (never created) — the live `git remote` lookup
  // fails exactly as it would for a deleted worktree.
  const goneWorktree = path.join(dir, "deleted-worktree");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ('s2','completed',?, 'acme/stored-repo')",
        goneWorktree
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s2"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.equal(
        session.attribution?.repositoryFullName,
        "acme/stored-repo",
        "the stored repo name is used when the live worktree lookup fails"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-4299: the SQL usage aggregate offers a Repository facet option for every resolved repo, dropping folder-only cwds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea4299-facet-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const worktreeAlpha = path.join(dir, "wt-alpha");
  // A cwd that is NOT a git repo — the live `git remote` lookup fails, so the
  // session has no resolved `repositoryFullName`. Its rows render "Unknown" and
  // it must NOT become a folder-named facet option (the FEA-4299 divergence).
  const folderOnly = path.join(dir, "peter.ulsteen");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await mkdir(worktreeAlpha, { recursive: true });
      initGitRepoWithOrigin(worktreeAlpha, "acme/alpha-repo");

      // Two sessions in the resolvable repo, one folder-only session with no
      // remote. `started_at` is set so the usage aggregate counts each row.
      await db.run(
        "INSERT INTO sessions (id, status, started_at, cwd, repo_full_name) VALUES ('a1','completed','2026-07-01T00:00:00.000Z',?,NULL)",
        worktreeAlpha
      );
      await db.run(
        "INSERT INTO sessions (id, status, started_at, cwd, repo_full_name) VALUES ('a2','completed','2026-07-02T00:00:00.000Z',?,NULL)",
        worktreeAlpha
      );
      await db.run(
        "INSERT INTO sessions (id, status, started_at, cwd, repo_full_name) VALUES ('u1','completed','2026-07-03T00:00:00.000Z',?,NULL)",
        folderOnly
      );

      // Empty request → the SQL `aggregateUsage` fast path drives byRepository.
      const usage = await getSharedAgentSessionUsage(db.syncSource, {});
      const optionIds = usage.byRepository.map(
        (entry) => entry.repositoryFullName
      );

      assert.deepEqual(
        optionIds,
        ["acme/alpha-repo"],
        "the resolved repo is the only Repository facet option"
      );
      assert.equal(
        usage.byRepository[0]?.sessionCount,
        2,
        "both sessions in the resolved repo fold into its facet count"
      );
      assert.ok(
        !optionIds.some((id) => id.includes("peter.ulsteen")),
        "a folder-only cwd never leaks a folder-named facet option"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-4299: the SQL usage facet offers the durable stored repo for a deleted-worktree session (matches the rendered row)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea4299-stored-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  // A cwd whose worktree was deleted: the live `git remote` lookup fails, so the
  // repo identity survives ONLY via the durable stored `repo_full_name` (FEA-3555).
  // The LIST/render path falls back to it, so the row renders `acme/gone-repo`
  // and it is filterable — the usage facet MUST offer it too, or the repo would
  // be rendered+filterable yet un-selectable (the FEA-4299 divergence).
  const goneWorktree = path.join(dir, "deleted-worktree");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status, started_at, cwd, repo_full_name) VALUES ('g1','completed','2026-07-01T00:00:00.000Z',?, 'acme/gone-repo')",
        goneWorktree
      );

      // The list/render path resolves the repo from the durable stored value.
      const [rendered] = await db.syncSource.loadSyncedSessions(
        ["g1"],
        emptyAttributionCache()
      );
      assert.equal(
        rendered?.attribution?.repositoryFullName,
        "acme/gone-repo",
        "the row renders the stored repo when the live worktree is gone"
      );

      // The usage facet (SQL aggregate) must offer the SAME repo as an option.
      const usage = await getSharedAgentSessionUsage(db.syncSource, {});
      assert.deepEqual(
        usage.byRepository.map((entry) => entry.repositoryFullName),
        ["acme/gone-repo"],
        "the stored repo is a selectable Repository facet option"
      );

      // And filtering the list by that offered value returns the row — proving
      // the option is honored, not dropped.
      const filtered = await getSharedAgentSessions(db.syncSource, {
        repositories: ["acme/gone-repo"],
      });
      assert.deepEqual(
        filtered.items.map((item) => item.id),
        ["g1"],
        "filtering by the offered repo returns the rendered row"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3555: no repo anywhere (no worktree, no stored name) yields no repo attribution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3555-none-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const goneWorktree = path.join(dir, "deleted-worktree");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ('s3','completed',?, NULL)",
        goneWorktree
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["s3"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      // No worktree, no launch metadata, no stored repo -> no attribution at all
      // (buildAttribution returns null when every field is empty).
      assert.equal(
        session.attribution?.repositoryFullName ?? null,
        null,
        "no repo is fabricated when neither live nor stored resolution has one"
      );
      // And nothing spurious was written to the durable cache.
      assert.equal(
        await readStoredRepoFullName(db, "s3"),
        null,
        "no repo name is persisted when none was resolved"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
