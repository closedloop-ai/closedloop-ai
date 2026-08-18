/**
 * @file enrichment-repo-identity.test.ts
 * @description FEA-1899 Desktop KLOC Attribution Engine — the SQLite-backed
 * repo/worktree resolution that gates which local cwds Desktop will run git
 * against, plus the git-only historical backfill.
 *
 * PLN-1535 M5 deleted this file's `gh-enrichment.ts` half along with the dead
 * local enrichment sweep; repo-identity capture and the historical backfill are
 * the parts D6 explicitly keeps, because they still feed session→repo
 * resolution.
 *
 * repo-identity + historical-backfill run on the single `DesktopPrisma` client —
 * typed delegates for the reads
 * (`resolveRepoForCwd`/`resolveRepoByFullName`/`isKnownRepoPath`) and raw
 * `$queryRawUnsafe`/`$executeRawUnsafe` (inside `prisma.write`) only for the
 * COALESCE-preserve upserts (`upsertRepo` RETURNING / `upsertWorktree`) and the
 * historical-backfill candidate anti-join. These tests build `DesktopPrisma`
 * via the shared `openTestPrisma` helper (electron-free, runs locally AND in
 * CI) and exercise the conversion: the typed resolvers, the RETURNING upsert
 * via a real `git init` repo, and the candidate anti-join excluding
 * already-mapped session cwds.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runHistoricalBackfill } from "../src/main/enrichment/historical-backfill.js";
import {
  captureRepoIdentity,
  cwdExists,
  isKnownRepoPath,
  resolveRepoByFullName,
  resolveRepoForCwd,
} from "../src/main/enrichment/repo-identity.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

const execFileAsync = promisify(execFile);

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cl-enrich-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// repo-identity: SQLite-backed resolution helpers
// ---------------------------------------------------------------------------

const NOW = "2026-06-18T00:00:00.000Z";

// repo-identity runs on the single `DesktopPrisma` client, so this harness uses
// the shared `openTestPrisma` — which builds the client over a migrated libSQL
// file with the PRODUCTION `createWriteQueue` (electron-free, so it runs locally
// AND in the node-test job). The functions under test read/write through
// `db.prisma`; seeding/assertion SQL uses the raw `db.store` handle on the SAME
// file (WAL → cross-connection
// visibility), as in production.
type TestDb = { prisma: OpenTestPrisma["prisma"]; store: OpenTestPrisma["db"] };

async function withDb(fn: (db: TestDb) => Promise<void>): Promise<void> {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await fn({ prisma, store });
  } finally {
    await close();
  }
}

async function seedRepo(
  db: TestDb,
  opts: {
    id: string;
    gitDir: string;
    repoFullName?: string | null;
    defaultBranch?: string | null;
    remoteUrl?: string | null;
  }
): Promise<void> {
  await db.store.query(
    `INSERT INTO repos (id, git_dir, remote_url, repo_full_name, default_branch, last_seen_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [
      opts.id,
      opts.gitDir,
      opts.remoteUrl ?? null,
      opts.repoFullName ?? null,
      opts.defaultBranch ?? null,
      NOW,
    ]
  );
}

async function seedWorktree(
  db: TestDb,
  opts: {
    id: string;
    repoId: string;
    worktreePath: string;
    branchName?: string | null;
  }
): Promise<void> {
  await db.store.query(
    `INSERT INTO repo_worktrees (id, repo_id, worktree_path, branch_name, last_seen_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [opts.id, opts.repoId, opts.worktreePath, opts.branchName ?? null, NOW]
  );
}

// --- isKnownRepoPath ---

test("isKnownRepoPath: true when path matches a repo git_dir exactly", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    assert.equal(await isKnownRepoPath(db.prisma, "/home/u/proj/.git"), true);
  });
});

test("isKnownRepoPath: true when path is the worktree root of a repo (path/.git)", async () => {
  await withDb(async (db) => {
    // Repo stored with the .git suffix; passing the working-tree root must match
    // via the `${path}/.git` arm.
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    assert.equal(await isKnownRepoPath(db.prisma, "/home/u/proj"), true);
  });
});

test("isKnownRepoPath: true when path matches a registered worktree_path", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    await seedWorktree(db, {
      id: "w1",
      repoId: "r1",
      worktreePath: "/home/u/proj-feature",
    });
    assert.equal(
      await isKnownRepoPath(db.prisma, "/home/u/proj-feature"),
      true
    );
  });
});

test("isKnownRepoPath: false for an unknown path", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    assert.equal(
      await isKnownRepoPath(db.prisma, "/some/unrelated/path"),
      false
    );
  });
});

// --- resolveRepoForCwd ---

test("resolveRepoForCwd: resolves via an exact worktree_path match", async () => {
  await withDb(async (db) => {
    await seedRepo(db, {
      id: "r1",
      gitDir: "/home/u/proj/.git",
      repoFullName: "org/proj",
    });
    await seedWorktree(db, {
      id: "w1",
      repoId: "r1",
      worktreePath: "/home/u/proj-feature",
    });
    const repo = await resolveRepoForCwd(db.prisma, "/home/u/proj-feature");
    assert.equal(repo?.id, "r1");
    assert.equal(repo?.repo_full_name, "org/proj");
    // Pin the camelCase→snake_case `git_dir` mapping (toRepoRow) — the field
    // historical-backfill consumes downstream.
    assert.equal(repo?.git_dir, "/home/u/proj/.git");
  });
});

test("resolveRepoForCwd: walks ancestors to find the repo by git_dir", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    // cwd is a nested subdir; the ancestor walk reaches /home/u/proj → .git.
    const repo = await resolveRepoForCwd(
      db.prisma,
      "/home/u/proj/packages/app/src"
    );
    assert.equal(repo?.id, "r1");
    assert.equal(repo?.git_dir, "/home/u/proj/.git");
  });
});

test("resolveRepoForCwd: returns null when nothing matches", async () => {
  await withDb(async (db) => {
    await seedRepo(db, { id: "r1", gitDir: "/home/u/proj/.git" });
    const repo = await resolveRepoForCwd(db.prisma, "/elsewhere/unknown");
    assert.equal(repo, null);
  });
});

// --- resolveRepoByFullName ---

test("resolveRepoByFullName: matches lowercased repo_full_name", async () => {
  await withDb(async (db) => {
    await seedRepo(db, {
      id: "r1",
      gitDir: "/home/u/proj/.git",
      repoFullName: "org/proj",
    });
    // Caller passes mixed case; helper lowercases before querying.
    const repo = await resolveRepoByFullName(db.prisma, "Org/Proj");
    assert.equal(repo?.id, "r1");
    assert.equal(repo?.git_dir, "/home/u/proj/.git");
  });
});

test("resolveRepoByFullName: returns null for an unknown full name", async () => {
  await withDb(async (db) => {
    await seedRepo(db, {
      id: "r1",
      gitDir: "/home/u/proj/.git",
      repoFullName: "org/proj",
    });
    const repo = await resolveRepoByFullName(db.prisma, "org/other");
    assert.equal(repo, null);
  });
});

// --- cwdExists ---

test("cwdExists: true for a directory that exists", async () => {
  await withTmpDir(async (dir) => {
    assert.equal(await cwdExists(dir), true);
  });
});

test("cwdExists: false for a path that does not exist", async () => {
  assert.equal(await cwdExists("/no/such/path/fea1899-xyz"), false);
});

// ---------------------------------------------------------------------------
// captureRepoIdentity: non-git cwd short-circuits to an empty result
// ---------------------------------------------------------------------------

test("captureRepoIdentity: returns an empty identity for a non-git directory", async () => {
  await withDb(async (db) => {
    await withTmpDir(async (cwd) => {
      // A fresh temp dir is not a git work tree, so isInsideWorkTree → false and
      // the capture short-circuits without touching the DB.
      const result = await captureRepoIdentity("git", cwd, db.prisma, NOW);
      assert.deepEqual(result, {
        repoId: null,
        gitDir: null,
        repoFullName: null,
        isWorktree: false,
      });
      const repos = await db.store.query("SELECT COUNT(*) AS n FROM repos");
      assert.equal((repos.rows[0] as { n: number | string }).n, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// captureRepoIdentity: real git repo → the RAW COALESCE-preserve upsert (RETURNING)
// ---------------------------------------------------------------------------

test("captureRepoIdentity: persists a repos row via the RETURNING upsert and is idempotent", async () => {
  await withDb(async (db) => {
    await withTmpDir(async (repoDir) => {
      // A real (remote-less) git work tree, so isInsideWorkTree → true and the
      // capture reaches upsertRepo — the raw `$queryRawUnsafe` INSERT … ON
      // CONFLICT … RETURNING id run through `prisma.write`.
      await execFileAsync("git", ["init"], { cwd: repoDir });

      const first = await captureRepoIdentity("git", repoDir, db.prisma, NOW);
      assert.ok(first.repoId, "repoId returned from the RETURNING upsert");
      assert.equal(first.isWorktree, false);

      const after = await db.store.query<{ id: string; git_dir: string }>(
        "SELECT id, git_dir FROM repos"
      );
      assert.equal(after.rows.length, 1, "one repos row persisted");
      assert.equal(after.rows[0]?.id, first.repoId);

      // A second capture conflicts on git_dir and RETURNs the SAME existing id
      // (not a fresh uuid) — the DO UPDATE branch's RETURNING.
      const second = await captureRepoIdentity("git", repoDir, db.prisma, NOW);
      assert.equal(second.repoId, first.repoId, "conflict returns existing id");
      const count = await db.store.query("SELECT COUNT(*) AS n FROM repos");
      assert.equal((count.rows[0] as { n: number | string }).n, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// runHistoricalBackfill: the candidate anti-join excludes already-mapped cwds
// ---------------------------------------------------------------------------

test("runHistoricalBackfill: skips sessions whose cwd already maps to a worktree or repo (anti-join)", async () => {
  await withDb(async (db) => {
    // A repo (resolvable by full name) whose git_dir also covers session C's cwd,
    // plus a worktree covering session B's cwd.
    await seedRepo(db, {
      id: "rp-proj",
      gitDir: "/covered2/.git",
      repoFullName: "owner/proj",
    });
    await seedWorktree(db, {
      id: "wt",
      repoId: "rp-proj",
      worktreePath: "/covered",
    });

    const meta = '{"repoFullName":"owner/proj"}';
    const seedSession = (id: string, cwd: string, startedAt: string) =>
      db.store.query(
        "INSERT INTO sessions (id, cwd, metadata, started_at) VALUES ($1, $2, $3, $4)",
        [id, cwd, meta, startedAt]
      );
    // A: uncovered cwd → a candidate; resolves via the mined repoFullName.
    await seedSession("sA", "/uncovered-A", "2026-06-18T03:00:00.000Z");
    // B: cwd IS a registered worktree_path → excluded by the first NOT EXISTS.
    await seedSession("sB", "/covered", "2026-06-18T02:00:00.000Z");
    // C: cwd || '/.git' IS a repos.git_dir → excluded by the second NOT EXISTS.
    await seedSession("sC", "/covered2", "2026-06-18T01:00:00.000Z");

    // Only sA survives the anti-join; cwdExists('/uncovered-A') is false, so it
    // resolves through resolveRepoByFullName('owner/proj') → 1. If the anti-join
    // failed to exclude B/C, they would also be processed (and could resolve via
    // the same metadata), so the exact count of 1 pins the exclusion.
    const resolved = await runHistoricalBackfill("git", db.prisma, 50, NOW);
    assert.equal(resolved, 1);
  });
});
