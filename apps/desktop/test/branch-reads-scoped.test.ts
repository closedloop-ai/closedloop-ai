import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type BranchKeyRow,
  readBranchCommitRowsForSessions,
  readBranchTokenAggregateRows,
  readBranchTokenAggregateRowsForBranch,
  readLocalBranchCommitRows,
  readLocalBranchLinkRows,
  readLocalBranchLinkRowsForBranch,
  readLocalBranchPrRows,
  readLocalBranchPrRowsForBranch,
} from "../src/main/database/branch-reads.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * PLN-1148 Phase 1 contract test for the branch-SCOPED detail reads. These prove
 * the new `…ForBranch` / `…ForSessions` variants return EXACTLY what the global
 * read-then-filter path returns for one branch — the equivalence the rewired
 * `getSharedBranchDetail` relies on — against a real libSQL DB seeded with a
 * MULTI-branch corpus (so a regression that leaks another branch's rows, or that
 * scans/attributes the wrong set, fails here).
 *
 * It also pins the two behaviours most at risk under scoping:
 * - FEA-2032 even-split: a multi-branch session's tokens still divide by its FULL
 *   branch count even though only the target branch is read.
 * - Null-repo matching: a repo-less branch is matched null-safely
 *   (`IS NOT DISTINCT FROM ?` with a bound NULL) and never leaks the repo'd
 *   branches.
 */

/**
 * Seed a multi-branch corpus:
 * - acme/web · feature/alpha   (art-ba)   ← target of the equivalence test
 * - acme/web · feature/beta    (art-bb)
 * - (null repo) · local-only   (art-bl)   ← target of the null-repo test
 * - one commit (art-c) reached by alpha via TWO of its sessions (dedup path)
 * Sessions: s1 (alpha+beta, multi-branch), s2 (alpha only), s3 (local-only).
 */
async function seedCorpus(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
) {
  for (const [id, started, ended] of [
    ["s1", "2026-06-01T00:00:00.000Z", "2026-06-01T02:00:00.000Z"],
    ["s2", "2026-06-02T00:00:00.000Z", "2026-06-02T01:00:00.000Z"],
    ["s3", "2026-06-03T00:00:00.000Z", "2026-06-03T01:00:00.000Z"],
  ]) {
    await db.run(
      "INSERT INTO sessions (id, status, started_at, ended_at, billing_mode) VALUES ($1, 'completed', $2, $3, 'metered_api')",
      id,
      started,
      ended
    );
  }

  // Branch artifacts (alpha, beta share a repo; local-only has a NULL repo).
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ('art-ba', 'ik-ba', 'branch', 'acme/web', 'feature/alpha', $1, $1)`,
    "2026-06-01T00:00:00.000Z"
  );
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ('art-bb', 'ik-bb', 'branch', 'acme/web', 'feature/beta', $1, $1)`,
    "2026-06-01T00:00:00.000Z"
  );
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, branch_name, created_at, last_seen_at)
     VALUES ('art-bl', 'ik-bl', 'branch', NULL, 'local-only', $1, $1)`,
    "2026-06-01T00:00:00.000Z"
  );
  // Commit artifact reached by alpha's sessions.
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, sha, committed_at, title, created_at, last_seen_at)
     VALUES ('art-c', 'ik-c', 'commit', 'acme/web', 'c0ffee1', $1, 'Do the thing', $1, $1)`,
    "2026-06-01T00:30:00.000Z"
  );

  // Links: s1→alpha,beta ; s2→alpha ; s3→local-only ; commit reached via s1 & s2.
  // FEA-2531: branch links are `git_push` (write + push evidence) so all three
  // branches pass the display gate and are active-write; commit links are
  // `git_commit`. `relation: "workspace"` keeps the pre-reparse shape (the reads
  // are method-based and ignore relation).
  const link = async (
    id: string,
    sessionId: string,
    artifactId: string,
    method: string,
    isPrimary: number,
    observedAt: string
  ) =>
    db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence, is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, $2, $3, 'workspace', $4, 'e', $5, 7, $6, $6)`,
      id,
      sessionId,
      artifactId,
      method,
      isPrimary,
      observedAt
    );
  await link("l1", "s1", "art-ba", "git_push", 1, "2026-06-01T00:30:00.000Z");
  await link("l2", "s1", "art-bb", "git_push", 0, "2026-06-01T00:31:00.000Z");
  await link("l3", "s2", "art-ba", "git_push", 1, "2026-06-02T00:30:00.000Z");
  await link("l4", "s2", "art-c", "git_commit", 0, "2026-06-02T00:31:00.000Z");
  await link("l5", "s1", "art-c", "git_commit", 0, "2026-06-01T00:32:00.000Z");
  await link("l6", "s3", "art-bl", "git_push", 1, "2026-06-03T00:30:00.000Z");

  // token_usage: s1 input 400 (split alpha/beta), s2 input 100 (alpha), s3 50.
  await db.run(
    "INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('s1', 'm1', 400, 40, 4, 2)"
  );
  await db.run(
    "INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('s2', 'm1', 100, 10, 0, 0)"
  );
  await db.run(
    "INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES ('s3', 'm1', 50, 5, 0, 0)"
  );

  // PRs (one per repo'd branch). The global read EXISTS-scopes via the branch
  // artifact, which both have.
  await db.run(
    `INSERT INTO pull_requests (id, pr_url, pr_number, repo_full_name, branch_name, state, observed_at, created_at)
     VALUES ('pr-a', 'https://gh/acme/web/pull/1', 1, 'acme/web', 'feature/alpha', 'open', $1, $1)`,
    "2026-06-01T03:00:00.000Z"
  );
  await db.run(
    `INSERT INTO pull_requests (id, pr_url, pr_number, repo_full_name, branch_name, state, observed_at, created_at)
     VALUES ('pr-b', 'https://gh/acme/web/pull/2', 2, 'acme/web', 'feature/beta', 'open', $1, $1)`,
    "2026-06-01T03:00:00.000Z"
  );
}

/** Filter global rows to one branch the same way the OLD detail path did. */
function onBranch<
  T extends { repoFullName: string | null; branchName: string },
>(rows: T[], key: BranchKeyRow): T[] {
  return rows.filter(
    (r) =>
      r.repoFullName === key.repoFullName && r.branchName === key.branchName
  );
}

async function withSeededDb(
  run: (prisma: DesktopPrisma) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "branch-reads-scoped-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  try {
    await seedCorpus(db);
    await run(db.prisma);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const ALPHA: BranchKeyRow = {
  repoFullName: "acme/web",
  branchName: "feature/alpha",
};

test("PLN-1148: scoped reads equal global-read-then-filter for a branch", async () => {
  await withSeededDb(async (prisma) => {
    // Links.
    const scopedLinks = await readLocalBranchLinkRowsForBranch(prisma, ALPHA);
    const globalLinks = onBranch(await readLocalBranchLinkRows(prisma), ALPHA);
    const bySession = (a: { sessionId: string }, b: { sessionId: string }) =>
      a.sessionId < b.sessionId ? -1 : 1;
    assert.deepEqual(
      scopedLinks.sort(bySession),
      globalLinks.sort(bySession),
      "scoped link rows must equal the global rows filtered to alpha"
    );
    assert.deepEqual(
      scopedLinks.map((l) => l.sessionId).sort(),
      ["s1", "s2"],
      "alpha's sessions are s1 and s2"
    );

    // PRs.
    const scopedPrs = await readLocalBranchPrRowsForBranch(prisma, ALPHA);
    const globalPrs = onBranch(await readLocalBranchPrRows(prisma), ALPHA);
    assert.deepEqual(scopedPrs, globalPrs, "scoped PRs equal global filtered");
    assert.equal(scopedPrs.length, 1);
    assert.equal(scopedPrs[0].prNumber, 1);

    // Commits (scoped by the branch's session set).
    const sessionIds = [...new Set(scopedLinks.map((l) => l.sessionId))];
    const scopedCommits = await readBranchCommitRowsForSessions(
      prisma,
      sessionIds,
      ALPHA
    );
    const globalCommits = onBranch(
      await readLocalBranchCommitRows(prisma),
      ALPHA
    );
    const bySha = (a: { sha: string }, b: { sha: string }) =>
      a.sha < b.sha ? -1 : 1;
    assert.deepEqual(
      scopedCommits.sort(bySha),
      globalCommits.sort(bySha),
      "scoped commits equal global filtered (and the commit is de-duped to one)"
    );
    assert.equal(
      scopedCommits.length,
      1,
      "commit reached via s1 & s2 → one row"
    );

    // Token aggregate.
    const scopedTokens = await readBranchTokenAggregateRowsForBranch(
      prisma,
      ALPHA
    );
    const globalTokens = onBranch(
      await readBranchTokenAggregateRows(prisma),
      ALPHA
    );
    assert.deepEqual(
      scopedTokens,
      globalTokens,
      "scoped token aggregate equals the global aggregate filtered to alpha"
    );
  });
});

test("PLN-1148: scoped token aggregate keeps the FEA-2032 even-split denominator", async () => {
  await withSeededDb(async (prisma) => {
    const rows = await readBranchTokenAggregateRowsForBranch(prisma, ALPHA);
    assert.equal(rows.length, 1, "one (model) row for alpha");
    const row = rows[0];
    assert.equal(row.model, "m1");
    // FEA-2531: the divisor counts a session's ACTIVE-WRITE branches. s1 pushed
    // alpha+beta → 400/2 = 200; s2 pushed alpha only → 100. The denominator stays
    // GLOBAL (counts both of s1's active-write branches) even though only alpha
    // was read.
    assert.equal(row.inputTokens, 300, "200 (s1 split) + 100 (s2 whole)");
    assert.equal(row.outputTokens, 30, "20 (s1 split) + 10 (s2)");
    assert.equal(row.cacheReadTokens, 2, "4/2 (s1) + 0 (s2)");
    assert.equal(row.cacheWriteTokens, 1, "2/2 (s1) + 0 (s2)");

    // Cross-check: beta gets exactly s1's other half, and the two sum to s1+s2.
    const beta = await readBranchTokenAggregateRowsForBranch(prisma, {
      repoFullName: "acme/web",
      branchName: "feature/beta",
    });
    assert.equal(beta[0].inputTokens, 200, "beta = s1's other half (400/2)");
    assert.equal(
      row.inputTokens + beta[0].inputTokens,
      500,
      "alpha + beta input = s1 (400) + s2 (100)"
    );
  });
});

test("PLN-1148: null-repo branch is matched null-safely and never leaks repo'd branches", async () => {
  await withSeededDb(async (prisma) => {
    const localKey: BranchKeyRow = {
      repoFullName: null,
      branchName: "local-only",
    };

    // Links: only s3, and never the acme branches' sessions.
    const links = await readLocalBranchLinkRowsForBranch(prisma, localKey);
    assert.deepEqual(
      links.map((l) => l.sessionId),
      ["s3"],
      "null-repo branch resolves only its own session"
    );
    assert.equal(links[0].repoFullName, null);

    // Token aggregate: the `IS NOT DISTINCT FROM ?` NULL bind returns this
    // branch's row (input 50) and nothing from acme/web.
    const tokens = await readBranchTokenAggregateRowsForBranch(
      prisma,
      localKey
    );
    assert.equal(tokens.length, 1, "exactly the local-only row");
    assert.equal(tokens[0].repoFullName, null);
    assert.equal(tokens[0].branchName, "local-only");
    assert.equal(tokens[0].inputTokens, 50);

    // And it equals the global read filtered the old way.
    assert.deepEqual(
      tokens,
      onBranch(await readBranchTokenAggregateRows(prisma), localKey)
    );
  });
});
