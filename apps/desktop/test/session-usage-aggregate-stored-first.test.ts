/**
 * @file session-usage-aggregate-stored-first.test.ts
 * @description ISS-5271: stored-first Repository-facet fold and durable fill-back.
 *
 * Drives `resolveUsageRepoSessionCounts`, `applyRepoFullNameFillBacks`, and the
 * end-to-end facet-identity ≡ filter-identity contract, covering the ISS-5271
 * ruling: stored `repo_full_name` wins outright; live git resolution runs only
 * when the cwd exists and has no stored name; gone cwds are settled by a µs
 * existence probe rather than a doomed spawn; fill-back is fill-only.
 *
 * The observability seam for "live resolver never ran": the real
 * `resolveSessionAttributionAsync` always populates `launchMetadataRootByCwd`
 * for any cwd it processes — so a fresh cache's `launchMetadataRootByCwd`
 * being empty after a fold is proof the live resolver was never invoked,
 * without mocking or timing.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  applyRepoFullNameFillBacks,
  resolveUsageRepoSessionCounts,
} from "../src/main/database/session-usage-aggregate.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { getSharedAgentSessionUsage } from "../src/main/session/shared-agent-sessions-api.js";
import {
  emptyAttributionCache,
  initGitRepoWithOrigin,
} from "./attribution-test-helpers.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// ---------------------------------------------------------------------------
// 1. Stored name wins without any live git resolution
// ---------------------------------------------------------------------------

test("ISS-5271: stored name wins without live git resolution", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "iss5271-stored-beats-live-")
  );
  const repoDir = path.join(dir, "repo");
  try {
    await mkdir(repoDir, { recursive: true });
    initGitRepoWithOrigin(repoDir, "acme/live-repo");

    const cache = emptyAttributionCache();
    const { repoSessionCounts, fillBackIntents } =
      await resolveUsageRepoSessionCounts(
        [
          {
            cwd: repoDir,
            repo_full_name: "acme/stored-wins",
            session_count: 2,
          },
        ],
        cache
      );

    assert.deepEqual(
      repoSessionCounts,
      [{ repositoryFullName: "acme/stored-wins", sessionCount: 2 }],
      "stored name is the only result — live-repo remote is ignored"
    );
    assert.equal(fillBackIntents.size, 0, "no fill-back when stored name won");
    assert.equal(
      cache.launchMetadataRootByCwd.size,
      0,
      "live resolver never ran: launchMetadataRootByCwd is empty"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Gone cwd dropped without live resolution; probe verdict seeded in cache
// ---------------------------------------------------------------------------

test("ISS-5271: gone cwd with no stored name is dropped and probe verdict seeded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5271-gone-cwd-"));
  const goneDir = path.join(dir, "deleted");
  try {
    await mkdir(goneDir, { recursive: true });
    await rm(goneDir, { recursive: true, force: true });

    const cache = emptyAttributionCache();
    const { repoSessionCounts, fillBackIntents } =
      await resolveUsageRepoSessionCounts(
        [{ cwd: goneDir, repo_full_name: null, session_count: 3 }],
        cache
      );

    assert.deepEqual(
      repoSessionCounts,
      [],
      "gone cwd with no stored name yields no counts"
    );
    assert.equal(
      cache.attributionByCwd.get(goneDir),
      null,
      "gone cwd existence verdict is seeded in the attribution cache"
    );
    assert.equal(
      cache.launchMetadataRootByCwd.size,
      0,
      "live resolver never ran: launchMetadataRootByCwd is empty"
    );
    assert.equal(fillBackIntents.size, 0, "no fill-back intent for a gone cwd");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Null cwd yields no counts and no probe
// ---------------------------------------------------------------------------

test("ISS-5271: null cwd yields no counts and no attribution probe", async () => {
  const cache = emptyAttributionCache();
  const { repoSessionCounts } = await resolveUsageRepoSessionCounts(
    [{ cwd: null, repo_full_name: null, session_count: 1 }],
    cache
  );

  assert.deepEqual(repoSessionCounts, [], "null cwd yields no counts");
  assert.equal(cache.attributionByCwd.size, 0, "no probe ran for null cwd");
});

// ---------------------------------------------------------------------------
// 4. Existing cwd with no stored name live-resolves and records fill-back
// ---------------------------------------------------------------------------

test("ISS-5271: existing cwd with no stored name live-resolves and records fill-back intent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5271-live-resolve-"));
  const repoDir = path.join(dir, "repo");
  try {
    await mkdir(repoDir, { recursive: true });
    initGitRepoWithOrigin(repoDir, "acme/alpha-repo");

    const cache = emptyAttributionCache();
    const { repoSessionCounts, fillBackIntents } =
      await resolveUsageRepoSessionCounts(
        [{ cwd: repoDir, repo_full_name: null, session_count: 2 }],
        cache
      );

    assert.deepEqual(repoSessionCounts, [
      { repositoryFullName: "acme/alpha-repo", sessionCount: 2 },
    ]);
    assert.equal(
      fillBackIntents.get(repoDir),
      "acme/alpha-repo",
      "fill-back intent is recorded for the live-resolved cwd"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Rows from two cwds resolving to one repo merge with summed counts
// ---------------------------------------------------------------------------

test("ISS-5271: two cwds resolving to one repo merge into one option with summed counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5271-merge-"));
  const cwd1 = path.join(dir, "repo1");
  const cwd2 = path.join(dir, "repo2");
  try {
    await mkdir(cwd1, { recursive: true });
    await mkdir(cwd2, { recursive: true });
    // cwd1 carries a stored name; cwd2 has none but its live git remote matches
    initGitRepoWithOrigin(cwd2, "acme/shared-repo");

    const cache = emptyAttributionCache();
    const { repoSessionCounts } = await resolveUsageRepoSessionCounts(
      [
        { cwd: cwd1, repo_full_name: "acme/shared-repo", session_count: 3 },
        { cwd: cwd2, repo_full_name: null, session_count: 2 },
      ],
      cache
    );

    assert.equal(
      repoSessionCounts.length,
      1,
      "two cwds resolving to one repo merge into a single option"
    );
    assert.equal(repoSessionCounts[0]?.repositoryFullName, "acme/shared-repo");
    assert.equal(
      repoSessionCounts[0]?.sessionCount,
      5,
      "session counts from both cwds are summed"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Fill-back is fill-only: non-empty stored name is never overwritten
// ---------------------------------------------------------------------------

test("ISS-5271: fill-back writes NULL and empty rows but skips rows with existing names", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    const cwd = "/w1";
    // Seed three sessions sharing one cwd: NULL, empty-string, and non-empty stored name.
    await db.query(
      "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ($1, 'completed', $2, NULL)",
      ["s-null", cwd]
    );
    await db.query(
      "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ($1, 'completed', $2, '')",
      ["s-empty", cwd]
    );
    await db.query(
      "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ($1, 'completed', $2, 'acme/newer-name')",
      ["s-existing", cwd]
    );

    await applyRepoFullNameFillBacks(prisma, new Map([[cwd, "acme/filled"]]));

    const rows = await prisma.read((reader) =>
      reader.session.findMany({
        where: { cwd },
        select: { id: true, repoFullName: true },
        orderBy: { id: "asc" },
      })
    );

    const byId: Record<string, string | null | undefined> = {};
    for (const row of rows) {
      byId[row.id] = row.repoFullName;
    }

    assert.equal(byId["s-null"], "acme/filled", "NULL row was filled");
    assert.equal(byId["s-empty"], "acme/filled", "empty-string row was filled");
    assert.equal(
      byId["s-existing"],
      "acme/newer-name",
      "non-empty stored name was NOT overwritten"
    );
  } finally {
    await close();
  }
});

test("ISS-5271: fill-back repairs a whitespace-only stored name (resolver treats it as absent)", async () => {
  const { db, prisma, close } = await openTestPrisma();
  try {
    const cwd = "/w2";
    // The resolver's `?.trim()` guard treats a whitespace-only stored value as
    // absent, so without a TRIM-aware fill predicate this row would live-resolve
    // on EVERY aggregation forever — the warm-path guarantee would be a lie.
    await db.query(
      "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ($1, 'completed', $2, '   ')",
      ["s-blank", cwd]
    );

    await applyRepoFullNameFillBacks(prisma, new Map([[cwd, "acme/repaired"]]));

    const row = await prisma.read((reader) =>
      reader.session.findUnique({
        where: { id: "s-blank" },
        select: { repoFullName: true },
      })
    );
    assert.equal(
      row?.repoFullName,
      "acme/repaired",
      "whitespace-only stored name was repaired by the fill-back"
    );
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// 7. Fill-back failure is swallowed — promise resolves
// ---------------------------------------------------------------------------

test("ISS-5271: fill-back failure is swallowed and the returned promise resolves", async () => {
  // A minimal stand-in that rejects on write — simulates a transient DB error.
  const rejectingPrisma = {
    write: () => Promise.reject(new Error("injected DB failure")),
  } as unknown as DesktopPrisma;

  await assert.doesNotReject(
    () =>
      applyRepoFullNameFillBacks(
        rejectingPrisma,
        new Map([["/any-cwd", "acme/repo"]])
      ),
    "a write failure must not propagate — fill-back is best-effort"
  );
});

// ---------------------------------------------------------------------------
// 8. The PRODUCTION aggregate persists its fill-back: a second aggregation
//    answers from the stored name even after the worktree is deleted
// ---------------------------------------------------------------------------

test("ISS-5271: production aggregate persists the fill-back so a second aggregation needs no live resolution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5271-second-agg-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const repoDir = path.join(dir, "repo");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await mkdir(repoDir, { recursive: true });
      initGitRepoWithOrigin(repoDir, "acme/beta-repo");
      await db.run(
        "INSERT INTO sessions (id, status, started_at, cwd, repo_full_name) VALUES ('agg1','completed','2026-07-01T00:00:00.000Z',?,NULL)",
        repoDir
      );

      // First aggregation drives the WHOLE production path (fold + fill-back):
      // stored name is absent and the worktree exists, so it live-resolves.
      const first = await getSharedAgentSessionUsage(db.syncSource, {});
      assert.deepEqual(
        first.byRepository.map((r) => r.repositoryFullName),
        ["acme/beta-repo"],
        "first aggregation live-resolves the repo"
      );
      assert.equal(
        await readStoredRepoFullName(db, "agg1"),
        "acme/beta-repo",
        "the production aggregate persisted the fill-back onto the row"
      );

      // Delete the worktree: live resolution is now IMPOSSIBLE, so the second
      // aggregation can only answer from the persisted stored name. This is a
      // behavioral proof that the fill-back write ran — removing the
      // applyRepoFullNameFillBacks call from the production path fails here.
      await rm(repoDir, { recursive: true, force: true });
      const second = await getSharedAgentSessionUsage(db.syncSource, {});
      assert.deepEqual(
        second.byRepository.map((r) => r.repositoryFullName),
        ["acme/beta-repo"],
        "second aggregation answers from the persisted stored name alone"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Facet identity ≡ filter identity (end-to-end via openSqliteAgentDatabase)
// ---------------------------------------------------------------------------

test("ISS-5271: stored repo is both offered as a facet option and returned by the filter", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5271-facet-identity-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  // A deleted worktree — only the durable stored repo_full_name survives.
  const goneWorktree = path.join(dir, "deleted-worktree");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status, started_at, cwd, repo_full_name) VALUES ('f1','completed','2026-07-01T00:00:00.000Z',?,'acme/stored-repo')",
        goneWorktree
      );

      // Facet options: the SQL aggregate must offer 'acme/stored-repo'.
      const usage = await getSharedAgentSessionUsage(db.syncSource, {});
      assert.deepEqual(
        usage.byRepository.map((r) => r.repositoryFullName),
        ["acme/stored-repo"],
        "stored repo is offered as a Repository facet option"
      );

      // Filter identity: the pre-hydration id scan must return the same session.
      assert.ok(
        db.syncSource.listRepositoryScopedSessionIds,
        "source implements listRepositoryScopedSessionIds"
      );
      const freshCache = emptyAttributionCache();
      const filteredIds = await db.syncSource.listRepositoryScopedSessionIds(
        ["acme/stored-repo"],
        freshCache
      );
      assert.deepEqual(
        filteredIds,
        ["f1"],
        "filtering by the offered stored repo returns the session id"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. The live-first SYNC lane supersedes a branch-derived / stale stored name
// ---------------------------------------------------------------------------

test("ISS-5271: a later live sync supersedes a branch-derived stored name once the cwd resolves", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5271-supersede-"));
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
      // A stored name authored by a non-cwd source (the ISS-4431 branch-
      // provenance third tier). Stored-first READS trust it; the freshness
      // contract is that the live-first SYNC lane replaces it the next time
      // the cwd actually resolves.
      await db.run(
        "INSERT INTO sessions (id, status, cwd, repo_full_name) VALUES ('sup1','completed',?,'acme/branch-derived')",
        worktree
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["sup1"],
        emptyAttributionCache()
      );
      assert.equal(
        session?.attribution?.repositoryFullName,
        "acme/live-repo",
        "the sync lane resolves the live remote, not the stored projection"
      );
      assert.equal(
        await readStoredRepoFullName(db, "sup1"),
        "acme/live-repo",
        "the live-differs-from-stored write-back superseded the branch-derived name"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
