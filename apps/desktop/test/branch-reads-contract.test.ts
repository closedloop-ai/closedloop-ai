import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readBranchTokenAggregateRows,
  readBranchUsageTokenRows,
  readDistinctBranchKeyRows,
  readLocalBranchLinkRows,
} from "../src/main/database/branch-reads.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

/**
 * FEA-1791 Phase 3 contract test for the branch-reads layer after it moved off
 * the raw `storeDb` handle onto the single `DesktopPrisma` client. Three reads
 * are now TYPED delegates and two of the assertions below prove the typed paths
 * against a real libSQL DB:
 *
 * - `readLocalBranchLinkRows` (`sessionArtifactLink.findMany` + nested artifact/
 *   session select; the `activityAt` COALESCE folded in JS) — proves the join,
 *   the COALESCE precedence, and that Int LOC columns arrive as JS numbers.
 * - `readDistinctBranchKeyRows` (`artifact.findMany` with `distinct`).
 * - `readBranchUsageTokenRows` (`tokenUsage.findMany` filtered through the new
 *   FEA-1791 `TokenUsage.session` relation) — proves the relation resolves and
 *   the bigint token columns coerce to JS numbers.
 *
 * It also seeds a non-branch (`kind='commit'`) artifact linked to the SAME
 * session to prove the typed `kind='branch'` `where` filters actually exclude
 * non-branch artifacts (the unit suite can only assert this for the raw reads).
 *
 * `readBranchTokenAggregateRows` stays raw (SUM…GROUP BY over a fan-out join);
 * its assertion proves the raw path runs on the Prisma client and Number()-
 * coerces the aggregate totals the raw path can surface as bigint.
 */

test("FEA-1791: branch reads run on the single Prisma client against real libSQL", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "branch-reads-contract-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status, started_at, ended_at, billing_mode) VALUES ($1, $2, $3, $4, $5)",
      "bs1",
      "completed",
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T01:00:00.000Z",
      "metered_api"
    );
    // A branch is an artifacts row (kind='branch') carrying the FEA-1899 LOC
    // enrichment columns.
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'branch', $3, $4, $5, $6, $7, $8, $8)`,
      "art-b",
      "ik-branch",
      "acme/web",
      "feature/x",
      100,
      20,
      5,
      "2026-06-01T00:00:00.000Z"
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'bs1', 'art-b', 'worked_on', 'transcript', 'e', 1, 1, $2, $2)`,
      "lnk-1",
      "2026-06-01T00:30:00.000Z"
    );
    // A non-branch (commit) artifact linked to the SAME session. The typed reads
    // must NOT surface it: their `kind='branch'` where-filters exclude it.
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, sha, committed_at, title,
          created_at, last_seen_at)
       VALUES ($1, $2, 'commit', $3, $4, $5, $6, $7, $7)`,
      "art-c",
      "ik-commit",
      "acme/web",
      "abc1234",
      "2026-06-01T00:45:00.000Z",
      "Do the thing",
      "2026-06-01T00:00:00.000Z"
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'bs1', 'art-c', 'worked_on', 'transcript', 'e', 0, 1, $2, $2)`,
      "lnk-2",
      "2026-06-01T00:45:00.000Z"
    );
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ('bs1', $1, 300, 100, 10, 5)`,
      "claude-sonnet-4-5"
    );

    // Link read (typed): branch artifact join + COALESCE(ended_at, started_at,
    // observed_at). The commit artifact's link must NOT add a row.
    const links = await readLocalBranchLinkRows(db.prisma);
    assert.equal(links.length, 1);
    const link = links[0];
    assert.equal(link.repoFullName, "acme/web");
    assert.equal(link.branchName, "feature/x");
    assert.equal(link.sessionId, "bs1");
    assert.equal(link.isPrimary, true);
    // ended_at wins the COALESCE over started_at / observed_at.
    assert.equal(link.activityAt, "2026-06-01T01:00:00.000Z");
    // INTEGER LOC columns must come back as JS numbers, not bigint.
    assert.equal(link.linesAdded, 100);
    assert.equal(typeof link.linesAdded, "number");
    assert.equal(link.linesRemoved, 20);
    assert.equal(link.filesChanged, 5);

    // Distinct (repo, branch) key read (typed) — the commit artifact is excluded.
    const keys = await readDistinctBranchKeyRows(db.prisma);
    assert.deepEqual(keys, [
      { repoFullName: "acme/web", branchName: "feature/x" },
    ]);

    // Usage-token read (typed, via the TokenUsage.session relation): bs1 is in
    // scope because it has a branch link; billing_mode flows through the nested
    // session select; bigint token columns coerce to JS numbers.
    const usage = await readBranchUsageTokenRows(db.prisma);
    assert.equal(usage.length, 1);
    const usageRow = usage[0];
    assert.equal(usageRow.sessionId, "bs1");
    assert.equal(usageRow.model, "claude-sonnet-4-5");
    assert.equal(usageRow.inputTokens, 300);
    assert.equal(typeof usageRow.inputTokens, "number");
    assert.equal(usageRow.outputTokens, 100);
    assert.equal(usageRow.cacheReadTokens, 10);
    assert.equal(usageRow.cacheWriteTokens, 5);
    assert.equal(usageRow.billingMode, "metered_api");

    // SUM(...) GROUP BY (branch, model) token aggregate (raw) — totals as JS
    // numbers. Single-branch session: 100% attribution (FEA-2032 fractional
    // attribution is N/A when N=1).
    const agg = await readBranchTokenAggregateRows(db.prisma);
    assert.equal(agg.length, 1);
    const row = agg[0];
    assert.equal(row.branchName, "feature/x");
    assert.equal(row.model, "claude-sonnet-4-5");
    assert.equal(row.inputTokens, 300);
    assert.equal(typeof row.inputTokens, "number");
    assert.equal(row.outputTokens, 100);
    assert.equal(row.cacheReadTokens, 10);
    assert.equal(row.cacheWriteTokens, 5);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2032: multi-branch session splits tokens evenly across branches", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "branch-reads-multibranch-")
  );
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status, started_at, ended_at, billing_mode) VALUES ($1, $2, $3, $4, $5)",
      "ms1",
      "completed",
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T02:00:00.000Z",
      "metered_api"
    );
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name,
          created_at, last_seen_at)
       VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
      "art-ba",
      "ik-branch-a",
      "acme/web",
      "feature/alpha",
      "2026-06-01T00:00:00.000Z"
    );
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name,
          created_at, last_seen_at)
       VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
      "art-bb",
      "ik-branch-b",
      "acme/web",
      "feature/beta",
      "2026-06-01T00:00:00.000Z"
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'ms1', 'art-ba', 'worked_on', 'transcript', 'e', 1, 1, $2, $2)`,
      "lnk-ma",
      "2026-06-01T00:30:00.000Z"
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'ms1', 'art-bb', 'worked_on', 'transcript', 'e', 0, 1, $2, $2)`,
      "lnk-mb",
      "2026-06-01T00:45:00.000Z"
    );
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES ('ms1', $1, 400, 200, 20, 10)`,
      "claude-sonnet-4-5"
    );

    const agg = await readBranchTokenAggregateRows(db.prisma);
    assert.equal(agg.length, 2, "should have one row per branch");

    const alpha = agg.find((r) => r.branchName === "feature/alpha");
    const beta = agg.find((r) => r.branchName === "feature/beta");
    assert.ok(alpha, "feature/alpha row should exist");
    assert.ok(beta, "feature/beta row should exist");

    assert.equal(alpha.inputTokens, 200, "alpha gets 400/2 = 200 input");
    assert.equal(alpha.outputTokens, 100, "alpha gets 200/2 = 100 output");
    assert.equal(alpha.cacheReadTokens, 10, "alpha gets 20/2 = 10 cache read");
    assert.equal(alpha.cacheWriteTokens, 5, "alpha gets 10/2 = 5 cache write");

    assert.equal(beta.inputTokens, 200, "beta gets 400/2 = 200 input");
    assert.equal(beta.outputTokens, 100, "beta gets 200/2 = 100 output");
    assert.equal(beta.cacheReadTokens, 10, "beta gets 20/2 = 10 cache read");
    assert.equal(beta.cacheWriteTokens, 5, "beta gets 10/2 = 5 cache write");

    const totalInput = alpha.inputTokens + beta.inputTokens;
    assert.equal(totalInput, 400, "sum of per-branch = session total");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
