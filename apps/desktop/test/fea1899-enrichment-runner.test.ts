/**
 * @file fea1899-enrichment-runner.test.ts
 * @description FEA-1899: the enrichment runner that sweeps null/provisional
 * artifacts, leases them to prevent concurrent work, applies LOC results (and
 * touches linked sessions so the cloud sync cursor advances), increments attempt
 * counters on failure, and caps retries at MAX_ENRICHMENT_ATTEMPTS by marking
 * not_applicable.
 *
 * The git/gh enrichment boundary spawns real subprocesses, so these tests keep
 * it inert: gh is forced unavailable via a bogus binary path (`isGhAvailable`
 * returns false) and seeded artifacts carry no git_dir, so `enrichArtifact`
 * yields null and the sweep takes its failure path deterministically — no real
 * repo fixture required. The lease/apply/cap DB transitions (the actual units)
 * are also asserted directly against the exported helpers over a real SQLite.
 *
 * FEA-1791 Phase 3: the runner moved off the raw `SqliteExecutor` handle onto the
 * single `DesktopPrisma` client — typed delegates for the eligible reads/writes
 * (`findMany`/`findFirst`, `updateMany` for the lease CAS, attempt increment,
 * apply, mark-not-applicable, and the link `upsert`) with raw `$executeRawUnsafe`
 * kept only for the two COALESCE-preserve / conditional-ON-CONFLICT writes that
 * have no typed form. This suite is the conversion's contract guard: the harness
 * builds `DesktopPrisma` via the shared `openTestPrisma` helper (electron-free),
 * so it pins those transitions
 * both locally and in CI.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEnrichmentResult,
  incrementAttempts,
  linkBranchSessionsToPr,
  markNotApplicable,
  resetSweepState,
  syncPullRequestLifecycle,
  triggerEnrichmentSweep,
  tryAcquireLease,
} from "../src/main/enrichment/enrichment-runner.js";
import { resetGhCache } from "../src/main/enrichment/gh-enrichment.js";
import {
  EnrichmentSource,
  EnrichmentState,
  LEASE_STALE_MS,
  MAX_ENRICHMENT_ATTEMPTS,
  type PrMetadata,
  PrState,
} from "../src/main/enrichment/types.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

// A binary path that cannot be spawned forces isGhAvailable() → false, so no
// `gh` subprocess runs. Artifacts seeded without a git_dir also skip all git
// subprocess calls, keeping each sweep a pure DB transition.
const NO_GH_PATH = "/nonexistent/gh-binary-for-tests";
const NO_GIT_PATH = "/nonexistent/git-binary-for-tests";

type Db = { prisma: OpenTestPrisma["prisma"] };
type Q = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

// FEA-1791 Phase 3: the runner now takes the single `DesktopPrisma` client, so
// this harness uses the shared `openTestPrisma` — which builds the client over a
// migrated libSQL file with the PRODUCTION `createWriteQueue` (electron-free, so
// it runs in the normal node-test job AND locally) — exercising the real
// conversion end-to-end: the runner reads/writes through the Prisma client, and
// the seeding/assertion SQL (`q`) uses the raw store handle on the SAME file
// (WAL gives cross-connection visibility, as in production).
async function withDb(run: (db: Db, q: Q) => Promise<void>): Promise<void> {
  // Module-level singletons (gh-availability cache + sweep debounce/running)
  // persist across tests in the same process — reset them per test for isolation.
  resetGhCache();
  resetSweepState();
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await run({ prisma }, (sql, params) => store.query(sql, params));
  } finally {
    await close();
  }
}

/** Insert a minimal artifact row; enrichment columns default unless overridden. */
async function insertArtifact(
  q: Q,
  art: {
    id: string;
    identityKey: string;
    kind: string;
    enrichmentState?: string | null;
    attempts?: number;
    leaseAt?: string | null;
    sha?: string | null;
    branchName?: string | null;
    prNumber?: number | null;
    repoFullName?: string | null;
    gitDir?: string | null;
  }
): Promise<void> {
  await q(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, git_dir, sha, branch_name,
        pr_number, enrichment_state, enrichment_attempts, lease_at,
        created_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'t1','t1')`,
    [
      art.id,
      art.identityKey,
      art.kind,
      art.repoFullName ?? null,
      art.gitDir ?? null,
      art.sha ?? null,
      art.branchName ?? null,
      art.prNumber ?? null,
      art.enrichmentState === undefined ? null : art.enrichmentState,
      art.attempts ?? 0,
      art.leaseAt ?? null,
    ]
  );
}

async function getArtifact(
  q: Q,
  id: string
): Promise<{
  enrichment_state: string | null;
  enrichment_attempts: number;
  lease_at: string | null;
  lines_added: number | null;
  lines_removed: number | null;
  files_changed: number | null;
  enrichment_source: string | null;
  enriched_at: string | null;
}> {
  const { rows } = await q("SELECT * FROM artifacts WHERE id = $1", [id]);
  return rows[0] as never;
}

test("FEA-1899: sweep picks up null + provisional commit artifacts and increments their attempts on failure", async () => {
  await withDb(async (db, q) => {
    // null-state and provisional rows are eligible; the failure path (no git_dir,
    // gh unavailable) increments attempts.
    await insertArtifact(q, {
      id: "a-null",
      identityKey: "commit:o/r:null1",
      kind: "commit",
      enrichmentState: null,
      sha: "null1",
      repoFullName: "owner/repo",
    });
    await insertArtifact(q, {
      id: "a-prov",
      identityKey: "commit:o/r:prov1",
      kind: "commit",
      enrichmentState: EnrichmentState.Provisional,
      sha: "prov1",
      repoFullName: "owner/repo",
    });

    await triggerEnrichmentSweep(db.prisma, NO_GIT_PATH, NO_GH_PATH, {
      debounce: false,
    });

    assert.equal((await getArtifact(q, "a-null")).enrichment_attempts, 1);
    assert.equal((await getArtifact(q, "a-prov")).enrichment_attempts, 1);
  });
});

test("FEA-1899: sweep skips final and not_applicable artifacts entirely", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "a-final",
      identityKey: "commit:o/r:final1",
      kind: "commit",
      enrichmentState: EnrichmentState.Final,
      sha: "final1",
      repoFullName: "owner/repo",
    });
    await insertArtifact(q, {
      id: "a-na",
      identityKey: "commit:o/r:na1",
      kind: "commit",
      enrichmentState: EnrichmentState.NotApplicable,
      sha: "na1",
      repoFullName: "owner/repo",
    });

    await triggerEnrichmentSweep(db.prisma, NO_GIT_PATH, NO_GH_PATH, {
      debounce: false,
    });

    // Untouched: still 0 attempts, state preserved (sweep never selected them).
    const fin = await getArtifact(q, "a-final");
    assert.equal(fin.enrichment_attempts, 0);
    assert.equal(fin.enrichment_state, EnrichmentState.Final);
    const na = await getArtifact(q, "a-na");
    assert.equal(na.enrichment_attempts, 0);
    assert.equal(na.enrichment_state, EnrichmentState.NotApplicable);
  });
});

test("FEA-1899: sweep skips closedloop_artifact rows (kind filter)", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "a-cl",
      identityKey: "cldoc:FEA-1899",
      kind: "closedloop_artifact",
      enrichmentState: null,
    });

    await triggerEnrichmentSweep(db.prisma, NO_GIT_PATH, NO_GH_PATH, {
      debounce: false,
    });

    // Closedloop docs are repo-agnostic and never enriched — left at 0 attempts.
    assert.equal((await getArtifact(q, "a-cl")).enrichment_attempts, 0);
  });
});

test("FEA-1899: artifact at MAX_ENRICHMENT_ATTEMPTS is marked not_applicable (capped, not retried)", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "a-capped",
      identityKey: "commit:o/r:capped1",
      kind: "commit",
      enrichmentState: EnrichmentState.Provisional,
      attempts: MAX_ENRICHMENT_ATTEMPTS,
      sha: "capped1",
      repoFullName: "owner/repo",
    });

    await triggerEnrichmentSweep(db.prisma, NO_GIT_PATH, NO_GH_PATH, {
      debounce: false,
    });

    const row = await getArtifact(q, "a-capped");
    assert.equal(row.enrichment_state, EnrichmentState.NotApplicable);
    // The cap branch runs BEFORE leasing/enriching, so attempts are not bumped.
    assert.equal(row.enrichment_attempts, MAX_ENRICHMENT_ATTEMPTS);
    assert.ok(row.enriched_at, "enriched_at stamped when capped");
  });
});

test("FEA-1899: debounce suppresses a second sweep inside the window", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "a1",
      identityKey: "commit:o/r:s1",
      kind: "commit",
      enrichmentState: null,
      sha: "s1",
      repoFullName: "owner/repo",
    });

    // First sweep runs (debounce on by default, lastSweepAt was reset to 0).
    await triggerEnrichmentSweep(db.prisma, NO_GIT_PATH, NO_GH_PATH);
    assert.equal((await getArtifact(q, "a1")).enrichment_attempts, 1);

    // Second sweep within ENRICHMENT_SWEEP_DEBOUNCE_MS is a no-op.
    await triggerEnrichmentSweep(db.prisma, NO_GIT_PATH, NO_GH_PATH);
    assert.equal(
      (await getArtifact(q, "a1")).enrichment_attempts,
      1,
      "debounced sweep did not run a second enrichment pass"
    );

    // Forcing debounce:false runs it again.
    await triggerEnrichmentSweep(db.prisma, NO_GIT_PATH, NO_GH_PATH, {
      debounce: false,
    });
    assert.equal((await getArtifact(q, "a1")).enrichment_attempts, 2);
  });
});

test("FEA-1899: tryAcquireLease grants on free row and blocks a concurrent second acquire", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "lease1",
      identityKey: "commit:o/r:lease1",
      kind: "commit",
      enrichmentState: null,
    });
    // Freshness is judged against real wall-clock (staleThreshold = Date.now() -
    // LEASE_STALE_MS), so the held lease must be stamped at ~real-now — not the
    // injected `now` clock — to count as fresh and block the second acquire.
    const now = new Date().toISOString();

    const first = await tryAcquireLease(db.prisma, "lease1", now);
    assert.equal(first, true, "free row leases successfully");

    // A second acquire while the lease is fresh must fail (no double-enrichment).
    const second = await tryAcquireLease(
      db.prisma,
      "lease1",
      new Date(Date.now() + 1000).toISOString()
    );
    assert.equal(second, false, "held lease blocks a concurrent acquire");
    assert.equal((await getArtifact(q, "lease1")).lease_at, now);
  });
});

test("FEA-1899: tryAcquireLease steals a stale lease past LEASE_STALE_MS", async () => {
  await withDb(async (db, q) => {
    // lease_at older than LEASE_STALE_MS relative to wall-clock now → stealable.
    const staleLease = new Date(
      Date.now() - LEASE_STALE_MS - 60_000
    ).toISOString();
    await insertArtifact(q, {
      id: "stale1",
      identityKey: "commit:o/r:stale1",
      kind: "commit",
      enrichmentState: null,
      leaseAt: staleLease,
    });

    const fresh = "2026-06-18T02:00:00.000Z";
    const acquired = await tryAcquireLease(db.prisma, "stale1", fresh);
    assert.equal(acquired, true, "stale lease is reclaimable");
    assert.equal((await getArtifact(q, "stale1")).lease_at, fresh);
  });
});

test("FEA-1899: applyEnrichmentResult writes LOC, resets attempts to 0, and touches linked sessions", async () => {
  await withDb(async (db, q) => {
    await q(
      "INSERT INTO sessions (id, status, updated_at) VALUES ('sess-1','completed','2026-01-01T00:00:00.000Z')"
    );
    await insertArtifact(q, {
      id: "art-ok",
      identityKey: "commit:o/r:ok1",
      kind: "commit",
      enrichmentState: EnrichmentState.Provisional,
      attempts: 3,
      leaseAt: "2026-06-18T03:00:00.000Z",
    });
    await q(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
       VALUES ('link-1','sess-1','art-ok','created','url_match','{}',1,'t1','t1')`
    );

    const now = "2026-06-18T03:05:00.000Z";
    await applyEnrichmentResult(
      db.prisma,
      "art-ok",
      {
        stats: { linesAdded: 100, linesRemoved: 25, filesChanged: 4 },
        state: EnrichmentState.Final,
        source: EnrichmentSource.GitShow,
      },
      now
    );

    const row = await getArtifact(q, "art-ok");
    assert.equal(row.lines_added, 100);
    assert.equal(row.lines_removed, 25);
    assert.equal(row.files_changed, 4);
    assert.equal(row.enrichment_state, EnrichmentState.Final);
    assert.equal(row.enrichment_source, EnrichmentSource.GitShow);
    assert.equal(row.enriched_at, now);
    assert.equal(
      row.enrichment_attempts,
      0,
      "a successful result resets the attempt counter"
    );

    // The session's updated_at is bumped so the cloud sync cursor re-picks it up
    // even though LOC lives on the artifact, not the session.
    const { rows } = await q(
      "SELECT updated_at FROM sessions WHERE id = 'sess-1'"
    );
    assert.equal((rows[0] as { updated_at: string }).updated_at, now);
  });
});

test("FEA-1899: applyEnrichmentResult tolerates a null stats payload", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "art-nullstats",
      identityKey: "branch:o/r:b1",
      kind: "branch",
      enrichmentState: EnrichmentState.Provisional,
      attempts: 2,
    });

    await applyEnrichmentResult(
      db.prisma,
      "art-nullstats",
      {
        stats: null,
        state: EnrichmentState.NotApplicable,
        source: EnrichmentSource.GitDiff,
      },
      "2026-06-18T04:00:00.000Z"
    );

    const row = await getArtifact(q, "art-nullstats");
    assert.equal(row.lines_added, null);
    assert.equal(row.lines_removed, null);
    assert.equal(row.files_changed, null);
    assert.equal(row.enrichment_state, EnrichmentState.NotApplicable);
    assert.equal(row.enrichment_attempts, 0);
  });
});

test("FEA-1899: incrementAttempts bumps the counter by one", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "art-inc",
      identityKey: "commit:o/r:inc1",
      kind: "commit",
      enrichmentState: EnrichmentState.Provisional,
      attempts: 2,
    });

    await incrementAttempts(db.prisma, "art-inc", "t");
    assert.equal((await getArtifact(q, "art-inc")).enrichment_attempts, 3);
    await incrementAttempts(db.prisma, "art-inc", "t");
    assert.equal((await getArtifact(q, "art-inc")).enrichment_attempts, 4);
  });
});

test("FEA-1899: markNotApplicable sets the terminal state and stamps enriched_at", async () => {
  await withDb(async (db, q) => {
    await insertArtifact(q, {
      id: "art-na",
      identityKey: "commit:o/r:na1",
      kind: "commit",
      enrichmentState: EnrichmentState.Provisional,
      attempts: MAX_ENRICHMENT_ATTEMPTS,
    });

    const now = "2026-06-18T05:00:00.000Z";
    await markNotApplicable(db.prisma, "art-na", now);

    const row = await getArtifact(q, "art-na");
    assert.equal(row.enrichment_state, EnrichmentState.NotApplicable);
    assert.equal(row.enriched_at, now);
  });
});

test("FEA-1899: linkBranchSessionsToPr upserts the PR artifact and links every branch session (idempotently)", async () => {
  await withDb(async (db, q) => {
    // A branch artifact with two sessions linked to it.
    await insertArtifact(q, {
      id: "branch-art",
      identityKey: "branch:owner/repo:feature-x",
      kind: "branch",
      branchName: "feature-x",
      gitDir: "/repo/.git",
    });
    await q(
      "INSERT INTO sessions (id, status, updated_at) VALUES ('s-a','completed','t1'),('s-b','completed','t1')"
    );
    for (const sessionId of ["s-a", "s-b"]) {
      await q(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
         VALUES ($1,$2,'branch-art','created','url_match','{}',1,'t1','t1')`,
        [`link-${sessionId}`, sessionId]
      );
    }

    await linkBranchSessionsToPr(
      db.prisma,
      { id: "branch-art", branch_name: "feature-x", git_dir: "/repo/.git" },
      123,
      "owner/repo"
    );

    // RAW conditional upsert created the PR artifact with the branch's metadata.
    const { rows: prRows } = await q(
      "SELECT id, pr_number, branch_name, git_dir FROM artifacts WHERE kind = 'pull_request'"
    );
    assert.equal(prRows.length, 1);
    const prArtifact = prRows[0] as {
      id: string;
      pr_number: number;
      branch_name: string | null;
      git_dir: string | null;
    };
    assert.equal(prArtifact.pr_number, 123);
    assert.equal(prArtifact.branch_name, "feature-x");
    assert.equal(prArtifact.git_dir, "/repo/.git");

    // The typed `upsert` created one workspace link per branch session.
    const workspaceLinks = async () =>
      (
        await q(
          "SELECT session_id FROM session_artifact_links WHERE artifact_id = $1 AND relation = 'workspace' ORDER BY session_id",
          [prArtifact.id]
        )
      ).rows.map((r) => (r as { session_id: string }).session_id);
    assert.deepEqual(await workspaceLinks(), ["s-a", "s-b"]);

    // Idempotent: a second call de-dupes the links (upsert empty update = DO
    // NOTHING) and the COALESCE-preserve upsert keeps the existing branch_name.
    await linkBranchSessionsToPr(
      db.prisma,
      { id: "branch-art", branch_name: "changed", git_dir: "/other/.git" },
      123,
      "owner/repo"
    );
    assert.deepEqual(await workspaceLinks(), ["s-a", "s-b"]);
    const { rows: afterRows } = await q(
      "SELECT branch_name, git_dir FROM artifacts WHERE kind = 'pull_request'"
    );
    const after = afterRows[0] as {
      branch_name: string | null;
      git_dir: string | null;
    };
    assert.equal(
      after.branch_name,
      "feature-x",
      "COALESCE preserved branch_name"
    );
    assert.equal(after.git_dir, "/repo/.git", "COALESCE preserved git_dir");
  });
});

// ---------------------------------------------------------------------------
// syncPullRequestLifecycle — branch "last active" must reflect the REAL GitHub
// merge/close instants, never the enrichment wall-clock time.
// ---------------------------------------------------------------------------

async function insertPullRequest(
  q: Q,
  pr: {
    repoFullName: string;
    prNumber: number;
    state?: string | null;
    mergedAt?: string | null;
    closedAt?: string | null;
    openedAt?: string | null;
  }
): Promise<void> {
  await q(
    `INSERT INTO pull_requests
       (id, pr_url, pr_number, repo_full_name, state, merged_at, closed_at,
        opened_at, harness, observed_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'claude_code','t1','t1')`,
    [
      `${pr.repoFullName}#${pr.prNumber}`,
      `https://github.com/${pr.repoFullName}/pull/${pr.prNumber}`,
      pr.prNumber,
      pr.repoFullName,
      pr.state ?? null,
      pr.mergedAt ?? null,
      pr.closedAt ?? null,
      pr.openedAt ?? null,
    ]
  );
}

async function getPullRequest(
  q: Q,
  repoFullName: string,
  prNumber: number
): Promise<{
  state: string | null;
  merged_at: string | null;
  closed_at: string | null;
  opened_at: string | null;
}> {
  const { rows } = await q(
    "SELECT state, merged_at, closed_at, opened_at FROM pull_requests WHERE repo_full_name = $1 AND pr_number = $2",
    [repoFullName, prNumber]
  );
  return rows[0] as never;
}

function prMeta(
  overrides: Partial<PrMetadata> & { prState: PrState }
): PrMetadata {
  return {
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    mergeCommitSha: null,
    baseRefName: null,
    openedAt: null,
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

test("FEA-1899: syncPullRequestLifecycle persists the REAL GitHub merge/close/open instants", async () => {
  await withDb(async (db, q) => {
    await insertPullRequest(q, { repoFullName: "owner/repo", prNumber: 42 });

    await syncPullRequestLifecycle(
      db.prisma,
      { pr_number: 42, repo_full_name: "owner/repo" },
      prMeta({
        prState: PrState.Merged,
        openedAt: "2026-06-01T08:00:00.000Z",
        mergedAt: "2026-06-02T09:30:00.000Z",
        closedAt: "2026-06-02T09:30:00.000Z",
      })
    );

    const row = await getPullRequest(q, "owner/repo", 42);
    assert.equal(row.state, "merged");
    assert.equal(row.merged_at, "2026-06-02T09:30:00.000Z");
    assert.equal(row.closed_at, "2026-06-02T09:30:00.000Z");
    assert.equal(row.opened_at, "2026-06-01T08:00:00.000Z");
  });
});

test("FEA-1899: syncPullRequestLifecycle never synthesizes 'now' when GitHub omits the merge/close time", async () => {
  await withDb(async (db, q) => {
    // The exact bug: a merged PR whose real merge time is unavailable must NOT
    // back-date the branch's "last active" to the post-import enrichment run.
    // We record the merged STATE but leave the timestamps null.
    await insertPullRequest(q, { repoFullName: "owner/repo", prNumber: 7 });

    await syncPullRequestLifecycle(
      db.prisma,
      { pr_number: 7, repo_full_name: "owner/repo" },
      prMeta({ prState: PrState.Merged })
    );

    const row = await getPullRequest(q, "owner/repo", 7);
    assert.equal(row.state, "merged", "state still records the merge");
    assert.equal(row.merged_at, null, "no fabricated merge timestamp");
    assert.equal(row.closed_at, null, "no fabricated close timestamp");
    assert.equal(row.opened_at, null);
  });
});

test("FEA-1899: syncPullRequestLifecycle preserves an existing real timestamp via COALESCE", async () => {
  await withDb(async (db, q) => {
    await insertPullRequest(q, {
      repoFullName: "owner/repo",
      prNumber: 9,
      state: "merged",
      mergedAt: "2026-05-01T00:00:00.000Z",
      closedAt: "2026-05-01T00:00:00.000Z",
    });

    // A later sweep reports the same terminal state; the original instant wins.
    await syncPullRequestLifecycle(
      db.prisma,
      { pr_number: 9, repo_full_name: "owner/repo" },
      prMeta({
        prState: PrState.Merged,
        mergedAt: "2026-06-18T00:00:00.000Z",
        closedAt: "2026-06-18T00:00:00.000Z",
      })
    );

    const row = await getPullRequest(q, "owner/repo", 9);
    assert.equal(row.merged_at, "2026-05-01T00:00:00.000Z");
    assert.equal(row.closed_at, "2026-05-01T00:00:00.000Z");
  });
});
