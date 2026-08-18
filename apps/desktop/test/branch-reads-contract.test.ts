import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  aggregateBranchCostCompleteness,
  BranchCostCompleteness,
} from "@repo/api/src/types/branch-usage";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
} from "@repo/api/src/types/session-artifact-link";
import {
  TokenCostBasis,
  TokenCostCompleteness,
  TokenSourceIdentityAvailability,
} from "@repo/api/src/types/token-cost-provenance";
import { buildDesktopBranchCostEvidence } from "../src/main/branch/branch-cost-evidence.js";
import {
  readBranchLifecycleEventRowsForBranch,
  readBranchSessionTokenRowsForBranch,
  readBranchTokenAggregateRows,
  readBranchUsageEventRows,
  readBranchUsageTokenRows,
  readDistinctBranchKeyRows,
  readLocalBranchLinkRows,
  readLocalBranchLinkRowsForBranch,
  readLocalBranchPrRows,
} from "../src/main/database/branch-reads.js";
import { readBoundedBranchUsageCostEvidence } from "../src/main/database/branch-usage-cost-evidence-read.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  AC_T0,
  AC_T1,
  branchNames,
  insertCommitArtifact,
  insertPullRequestArtifact,
  insertPullRequestRow,
  linkPullRequestArtifact,
  seeder,
  withAcDb,
} from "./branch-reads-ac-test-helpers.js";

/**
 * Contract test for the branch-reads layer on the single `DesktopPrisma` client.
 * Three reads are TYPED delegates and two of the assertions below prove the
 * typed paths against a real libSQL DB:
 *
 * - `readLocalBranchLinkRows` (`sessionArtifactLink.findMany` + nested artifact/
 *   session select; the `activityAt` COALESCE folded in JS) — proves the join,
 *   the COALESCE precedence, and that Int LOC columns arrive as JS numbers.
 * - `readDistinctBranchKeyRows` (`artifact.findMany` with `distinct`).
 * - `readBranchUsageTokenRows` (`tokenUsage.findMany` filtered through the
 *   `TokenUsage.session` relation) — proves the relation resolves and the bigint
 *   token columns coerce to JS numbers.
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
    detectBillingMode: () => "api",
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
      "api"
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
    // FEA-2531: a `git_push` link is both a write method AND push evidence, so
    // the branch passes the display gate and the row-level write filter.
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'bs1', 'art-b', 'created', 'git_push', 'e', 1, 7, $2, $2)`,
      "lnk-1",
      "2026-06-01T00:30:00.000Z"
    );
    // A non-branch (commit) artifact linked to the SAME session. The typed reads
    // must NOT surface it: their `kind='branch'` where-filters exclude it. It
    // carries a WRITE method (`git_commit`) so the kind filter — not the FEA-2531
    // method filter — is what excludes it.
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
       VALUES ($1, 'bs1', 'art-c', 'created', 'git_commit', 'e', 0, 7, $2, $2)`,
      "lnk-2",
      "2026-06-01T00:45:00.000Z"
    );
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
       VALUES ('bs1', $1, 300, 100, 10, 5, 3, 2)`,
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
      {
        repoFullName: "acme/web",
        branchName: "feature/x",
        hasLocalPublication: true,
      },
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
    assert.equal(usageRow.cacheWrite5mTokens, 3);
    assert.equal(usageRow.cacheWrite1hTokens, 2);
    // A stored, DEFINITE mode is preserved as-is by the resolver.
    assert.equal(usageRow.billingMode, "api");
    // FEA-4270: the sessions JOIN surfaces the owning session's start instant so
    // branch AI spend can be windowed by when the session ran (not by its
    // branch's lastActivityAt). Proves the `s.started_at` column reaches the row.
    assert.equal(usageRow.sessionStartedAt, "2026-06-01T00:00:00.000Z");

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

test("FEA-2159: readLocalBranchPrRows joins the PR artifact's LOC for an un-enriched branch", async () => {
  // The production bug (Daniel's desktop): the branch artifact carries NO LOC
  // while its merged PR artifact (kind='pull_request') IS enriched — the same
  // source the delivery dashboard medians. The PR read must surface that LOC so
  // the list projection can fall back to it. Proves the LEFT-JOIN SQL is valid
  // libSQL AND that INTEGER LOC coerces to JS number (not bigint).
  const dir = await mkdtemp(path.join(os.tmpdir(), "branch-reads-pr-loc-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  try {
    await db.run(
      "INSERT INTO sessions (id, status, started_at, ended_at, billing_mode) VALUES ($1, $2, $3, $4, $5)",
      "ps1",
      "completed",
      "2026-06-01T00:00:00.000Z",
      "2026-06-01T01:00:00.000Z",
      "metered_api"
    );
    // Branch artifact — UN-ENRICHED (lines_added/removed/changed all null).
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, branch_name,
          created_at, last_seen_at)
       VALUES ($1, $2, 'branch', $3, $4, $5, $5)`,
      "art-pb",
      "ik-pr-branch",
      "acme/web",
      "feature/pr-enriched",
      "2026-06-01T00:00:00.000Z"
    );
    // FEA-2531: push evidence (`git_push`) so the branch passes the display gate
    // and its PR is surfaced.
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'ps1', 'art-pb', 'created', 'git_push', 'e', 1, 7, $2, $2)`,
      "lnk-p1",
      "2026-06-01T00:30:00.000Z"
    );
    // PR lifecycle row (no LOC columns — pull_requests never carries LOC).
    await db.run(
      `INSERT INTO pull_requests
         (id, pr_url, pr_number, repo_full_name, branch_name, state,
          merged_at, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'closed', $6, $6, $6)`,
      "pr-1",
      "https://github.com/acme/web/pull/7",
      7,
      "acme/web",
      "feature/pr-enriched",
      "2026-06-11T10:00:00.000Z"
    );
    await db.run(
      `INSERT INTO pull_request_status_observations
         (id, repo_full_name, pr_number, state, is_draft, source,
          observed_at, last_checked_at)
       VALUES ($1, $2, $3, 'closed', 0, 'persisted-test', $4, $4)`,
      "pr-observation-1",
      "acme/web",
      7,
      "2026-06-11T10:01:00.000Z"
    );
    await db.run(
      `INSERT INTO pull_requests
         (id, pr_url, pr_number, repo_full_name, branch_name, state,
          opened_at, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $6, $6)`,
      "pr-2",
      "https://github.com/acme/web/pull/8",
      8,
      "acme/web",
      "feature/pr-enriched",
      "2026-06-12T10:00:00.000Z"
    );
    await db.run(
      `INSERT INTO pull_request_status_observations
         (id, repo_full_name, pr_number, state, is_draft, source,
          observed_at, last_checked_at)
       VALUES ($1, $2, $3, 'open', 0, 'persisted-test', $4, $4)`,
      "pr-observation-2",
      "acme/web",
      8,
      "2026-06-12T10:01:00.000Z"
    );
    // PR artifact (kind='pull_request') — ENRICHED with LOC, matched by
    // (repo_full_name, pr_number) to the lifecycle row above.
    await db.run(
      `INSERT INTO artifacts
         (id, identity_key, kind, repo_full_name, pr_number,
          lines_added, lines_removed, files_changed, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, $7, $8, $8)`,
      "art-pr",
      "ik-pr-artifact",
      "acme/web",
      7,
      600,
      22,
      9,
      "2026-06-01T00:00:00.000Z"
    );

    const prs = await readLocalBranchPrRows(db.prisma);
    // `prNumber` is nullable on `BranchPrRow` (the read does not filter
    // unenriched rows out). Order a null LAST rather than coercing it to 0, so
    // an unexpected null stays visible in the deepEqual instead of sorting into
    // the 7/8 window and reading as a real PR number.
    const prNumbers = prs
      .map(({ prNumber }) => prNumber)
      .sort(
        (left, right) =>
          (left ?? Number.POSITIVE_INFINITY) -
          (right ?? Number.POSITIVE_INFINITY)
      );
    assert.deepEqual(prNumbers, [7, 8]);
    const pr = prs.find(({ prNumber }) => prNumber === 7);
    assert.ok(pr);
    assert.equal(pr.branchName, "feature/pr-enriched");
    assert.equal(pr.prNumber, 7);
    assert.equal(pr.isDraft, false);
    // LOC comes from the joined PR artifact, coerced to JS number.
    assert.equal(pr.linesAdded, 600);
    assert.equal(typeof pr.linesAdded, "number");
    assert.equal(pr.linesRemoved, 22);
    assert.equal(pr.filesChanged, 9);
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
    // FEA-2531: the session PUSHED both branches (`git_push` = write + push
    // evidence), so both are active-write links and the divisor is 2.
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'ms1', 'art-ba', 'created', 'git_push', 'e', 1, 7, $2, $2)`,
      "lnk-ma",
      "2026-06-01T00:30:00.000Z"
    );
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ($1, 'ms1', 'art-bb', 'created', 'git_push', 'e', 0, 7, $2, $2)`,
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

test("FEA-3805: branch detail lifecycle read orders write, PR, review, and rework evidence", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branch = await s.branch({ branch: "feature/phase" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: branch,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-06-01T00:05:00.000Z",
    });
    await insertPullRequestArtifact(db, {
      id: "pr-phase",
      branch: "feature/phase",
    });
    await linkPullRequestArtifact(db, {
      id: "lnk-pr-created",
      session: "s1",
      artifactId: "pr-phase",
      relation: ArtifactRefRelation.Created,
      method: "gh_pr_create",
      observedAt: "2026-06-01T00:20:00.000Z",
    });
    await linkPullRequestArtifact(db, {
      id: "lnk-pr-feedback",
      session: "s1",
      artifactId: "pr-phase",
      relation: ArtifactRefRelation.Reviewed,
      method: ArtifactRefMethod.PrReviewFeedbackCommand,
      observedAt: "2026-06-01T00:40:00.000Z",
    });
    await insertCommitArtifact(db, {
      id: "commit-post-pr",
      session: "s1",
      branch: "feature/phase",
      committedAt: "2026-06-01T00:50:00.000Z",
      linkId: "lnk-commit-post-pr",
    });
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd_estimated)
       VALUES ('s1', 'm1', 600, 300, 60, 30, 0.9)`
    );

    const key = { repoFullName: "acme/web", branchName: "feature/phase" };
    const events = await readBranchLifecycleEventRowsForBranch(db.prisma, key);
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        BranchLifecycleBoundaryKind.BranchWrite,
        BranchLifecycleBoundaryKind.PrRaised,
        BranchLifecycleBoundaryKind.ReviewFeedback,
        BranchLifecycleBoundaryKind.BranchWrite,
      ]
    );
    assert.deepEqual(
      events.map((event) => event.observedAt),
      [
        "2026-06-01T00:05:00.000Z",
        "2026-06-01T00:20:00.000Z",
        "2026-06-01T00:40:00.000Z",
        "2026-06-01T00:50:00.000Z",
      ]
    );
    assert.equal(events[0]?.sessionStartedAt, AC_T0);
    assert.equal(events[0]?.sessionEndedAt, AC_T1);
    assert.equal(
      events[3]?.evidenceId,
      "desktop-artifact-link:lnk-commit-post-pr"
    );

    const sessionTokens = await readBranchSessionTokenRowsForBranch(
      db.prisma,
      key
    );
    assert.equal(sessionTokens.length, 1);
    assert.equal(sessionTokens[0]?.branchCount, 1);
    assert.equal(sessionTokens[0]?.inputTokens, 600);
    assert.equal(sessionTokens[0]?.outputTokens, 300);
    assert.equal(sessionTokens[0]?.cacheReadTokens, 60);
    assert.equal(sessionTokens[0]?.cacheWriteTokens, 30);
    assert.equal(sessionTokens[0]?.costUsdEstimated, 0.9);
    assert.equal(sessionTokens[0]?.evenSplitCostUsd, 0.9);
  });
});

test("FEA-3805: tied PR-create lifecycle events use cloud-compatible semantic ordering", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branch = await s.branch({ branch: "feature/tie" });
    await s.session("s1");
    await db.run(
      `INSERT INTO session_artifact_links
         (id, session_id, artifact_id, relation, method, evidence,
          is_primary, extractor_version, observed_at, created_at)
       VALUES ('zzz-branch-write', 's1', $1, $2, 'gh_pr_create', 'e', 0, 7, $3, $3)`,
      branch,
      ArtifactRefRelation.Created,
      "2026-06-01T00:20:00.000Z"
    );
    await insertPullRequestArtifact(db, {
      id: "pr-tie",
      branch: "feature/tie",
    });
    await linkPullRequestArtifact(db, {
      id: "aaa-pr-created",
      session: "s1",
      artifactId: "pr-tie",
      relation: ArtifactRefRelation.Created,
      method: "gh_pr_create",
      observedAt: "2026-06-01T00:20:00.000Z",
    });

    const events = await readBranchLifecycleEventRowsForBranch(db.prisma, {
      repoFullName: "acme/web",
      branchName: "feature/tie",
    });
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        BranchLifecycleBoundaryKind.BranchWrite,
        BranchLifecycleBoundaryKind.PrRaised,
      ]
    );
  });
});

test("FEA-3805: PR lifecycle read falls back to pull_requests branch name", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branch = await s.branch({ branch: "feature/pr-fallback" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: branch,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-06-01T00:05:00.000Z",
    });
    await insertPullRequestRow(db, {
      id: "pr-row-fallback",
      branch: "feature/pr-fallback",
      prNumber: 77,
    });
    await insertPullRequestArtifact(db, {
      id: "pr-artifact-fallback",
      branch: null,
      prNumber: 77,
    });
    await linkPullRequestArtifact(db, {
      id: "lnk-pr-fallback-created",
      session: "s1",
      artifactId: "pr-artifact-fallback",
      relation: ArtifactRefRelation.Created,
      method: "gh_pr_create",
      observedAt: "2026-06-01T00:20:00.000Z",
    });
    await linkPullRequestArtifact(db, {
      id: "lnk-pr-fallback-feedback",
      session: "s1",
      artifactId: "pr-artifact-fallback",
      relation: ArtifactRefRelation.Reviewed,
      method: ArtifactRefMethod.PrReviewFeedbackCommand,
      observedAt: "2026-06-01T00:40:00.000Z",
    });

    const events = await readBranchLifecycleEventRowsForBranch(db.prisma, {
      repoFullName: "acme/web",
      branchName: "feature/pr-fallback",
    });
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        BranchLifecycleBoundaryKind.BranchWrite,
        BranchLifecycleBoundaryKind.PrRaised,
        BranchLifecycleBoundaryKind.ReviewFeedback,
      ]
    );
  });
});

test("FEA-3805: read-only branch and PR refs do not create review or rework evidence", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const branch = await s.branch({ branch: "feature/read-only-phase" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: branch,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
      observedAt: "2026-06-01T00:05:00.000Z",
    });
    await s.link({
      session: "s1",
      artifactId: branch,
      method: "git_checkout",
      relation: ArtifactRefRelation.Workspace,
      observedAt: "2026-06-01T00:30:00.000Z",
    });
    await insertPullRequestArtifact(db, {
      id: "pr-read-only",
      branch: "feature/read-only-phase",
    });
    await linkPullRequestArtifact(db, {
      id: "lnk-pr-view",
      session: "s1",
      artifactId: "pr-read-only",
      relation: ArtifactRefRelation.Reviewed,
      method: ArtifactRefMethod.PrReviewCommand,
      observedAt: "2026-06-01T00:40:00.000Z",
    });

    const events = await readBranchLifecycleEventRowsForBranch(db.prisma, {
      repoFullName: "acme/web",
      branchName: "feature/read-only-phase",
    });
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        BranchLifecycleBoundaryKind.BranchWrite,
        BranchLifecycleBoundaryKind.ReadOnlyReference,
        BranchLifecycleBoundaryKind.ReadOnlyReference,
      ]
    );
    assert.equal(
      events.some(
        (event) => event.kind === BranchLifecycleBoundaryKind.ReviewFeedback
      ),
      false
    );
  });
});

test("FEA-3805: session token read uses the global active-write branch denominator", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "feature/x" });
    const y = await s.branch({ branch: "feature/y" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: x,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    await s.link({
      session: "s1",
      artifactId: y,
      method: "gh_pr_create",
      relation: ArtifactRefRelation.Created,
    });
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd_estimated)
       VALUES ('s1', 'm1', 400, 200, 20, 10, 1.0)`
    );

    const sessionTokens = await readBranchSessionTokenRowsForBranch(db.prisma, {
      repoFullName: "acme/web",
      branchName: "feature/x",
    });
    assert.equal(sessionTokens.length, 1);
    assert.equal(sessionTokens[0]?.branchCount, 2);
    assert.equal(sessionTokens[0]?.costUsdEstimated, 1);
    assert.equal(sessionTokens[0]?.evenSplitCostUsd, 0.5);
  });
});

test("FEA-4270: readBranchUsageEventRows surfaces per-event created_at + captured cost", async () => {
  // The per-event read must carry each token_events row's own created_at AND its
  // cost_usd_estimated so the windowed branch-spend path can sum only in-window
  // events by their real timestamps (not the session-level aggregate instant).
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "feature/x" });
    await s.session("s1");
    await s.link({
      session: "s1",
      artifactId: x,
      method: "git_push",
      relation: ArtifactRefRelation.Created,
    });
    // Two per-event turns at DIFFERENT instants — one costed, one un-priced.
    const sourceIdentity = {
      availability: TokenSourceIdentityAvailability.Available,
      scheme: "claude-jsonl",
      sourceRecordIds: ["record-1"],
    };
    const costSummary = {
      completeness: TokenCostCompleteness.Complete,
      subtotalUsd: 0.4,
      lanes: [{ basis: TokenCostBasis.ApiEstimated, subtotalUsd: 0.4 }],
    };
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated,
          source_identity, cost_summary)
       VALUES ('s1', 'm1', '2026-06-20T10:00:00.000Z', 5, 2, 0, 0, 0.4, $1, $2)`,
      JSON.stringify(sourceIdentity),
      JSON.stringify(costSummary)
    );
    await db.run(
      `INSERT INTO token_events
         (session_id, model, created_at, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd_estimated)
       VALUES ('s1', 'm1', '2026-06-21T11:00:00.000Z', 3, 1, 0, 0, NULL)`
    );

    const events = await readBranchUsageEventRows(db.prisma);
    assert.equal(events.length, 2);
    const byTime = new Map(events.map((event) => [event.createdAt, event]));
    // First turn carries its real per-event created_at + captured cost.
    const first = byTime.get("2026-06-20T10:00:00.000Z");
    assert.ok(first);
    assert.equal(first?.inputTokens, 5);
    assert.equal(first?.costUsdEstimated, 0.4);
    assert.equal(Object.hasOwn(first, "sourceIdentity"), false);
    assert.equal(Object.hasOwn(first, "costSummary"), false);
    const evidenceRead = await readBoundedBranchUsageCostEvidence(
      db.prisma,
      first?.eventRowId && first.eventFingerprint
        ? [
            {
              eventRowId: first.eventRowId,
              eventFingerprint: first.eventFingerprint,
            },
          ]
        : []
    );
    assert.equal(evidenceRead.exceeded, false);
    const evidencePayload = evidenceRead.rows[0];
    assert.deepEqual(evidencePayload?.sourceIdentity, sourceIdentity);
    assert.deepEqual(evidencePayload?.costSummary, costSummary);
    const firstEvidence = { ...first, ...evidencePayload };
    assert.deepEqual(
      aggregateBranchCostCompleteness(
        buildDesktopBranchCostEvidence({
          tokenRows: [],
          evidenceRows: [firstEvidence],
          allEventRows: events,
          subtotalRows: [first],
          windowActive: true,
          evidenceExceeded: false,
        })
      ),
      {
        completeness: BranchCostCompleteness.Complete,
        subtotalUsd: 0.4,
        lanes: { subscriptionEquivalentCost: 0, apiEstimatedCost: 0.4 },
      }
    );
    // Second turn is un-priced → null cost (never re-derived list price), but its
    // own created_at is preserved so it buckets/windows at its real instant.
    const second = byTime.get("2026-06-21T11:00:00.000Z");
    assert.equal(second?.inputTokens, 3);
    assert.equal(second?.costUsdEstimated, null);
  });
});

test("FEA-2531 AC1: start-on-main read link + pushed feat/x → 100% feat/x, main absent (legacy + new read methods)", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    // Shared `main` artifact, read-only from BOTH sessions — sA via the legacy
    // `slug_in_branch` method, sB via the renamed `start_branch`. Neither is a
    // write method and main has no push evidence, so main never displays and
    // never attributes.
    const main = await s.branch({ branch: "main" });
    const featA = await s.branch({ branch: "feature/a" });
    const featB = await s.branch({ branch: "feature/b" });
    await s.session("sA");
    await s.session("sB");
    await s.link({ session: "sA", artifactId: main, method: "slug_in_branch" });
    await s.link({ session: "sB", artifactId: main, method: "start_branch" });
    await s.link({ session: "sA", artifactId: featA, method: "git_push" });
    await s.link({ session: "sB", artifactId: featB, method: "git_push" });
    await s.tokens("sA", 100);
    await s.tokens("sB", 100);

    const links = await readLocalBranchLinkRows(db.prisma);
    assert.deepEqual(
      branchNames(links),
      ["feature/a", "feature/b"],
      "only the pushed feat branches list; main (read-only) is absent"
    );
    const keys = await readDistinctBranchKeyRows(db.prisma);
    assert.deepEqual(branchNames(keys), ["feature/a", "feature/b"]);

    const agg = await readBranchTokenAggregateRows(db.prisma);
    const byBranch = new Map(agg.map((r) => [r.branchName, r]));
    // branch_count = 1 per session (main is read-only, not active-write) → 100%.
    assert.equal(byBranch.get("feature/a")?.inputTokens, 100);
    assert.equal(byBranch.get("feature/b")?.inputTokens, 100);
    assert.equal(byBranch.has("main"), false, "main not attributed");
  });
});

test("FEA-2531 AC2: reads A,B (checkout) + pushes C → 100% C, A,B absent", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const a = await s.branch({ branch: "read/a" });
    const b = await s.branch({ branch: "read/b" });
    const c = await s.branch({ branch: "push/c" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: a, method: "git_checkout" });
    await s.link({ session: "s1", artifactId: b, method: "git_checkout" });
    await s.link({ session: "s1", artifactId: c, method: "git_push" });
    await s.tokens("s1", 100);

    const links = await readLocalBranchLinkRows(db.prisma);
    assert.deepEqual(branchNames(links), ["push/c"]);
    const agg = await readBranchTokenAggregateRows(db.prisma);
    assert.equal(agg.length, 1);
    assert.equal(agg[0].branchName, "push/c");
    assert.equal(
      agg[0].inputTokens,
      100,
      "checkout branches excluded → 100% C"
    );
  });
});

test("FEA-2531 AC3: session pushes two branches → 50/50, nothing else", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "push/x" });
    const y = await s.branch({ branch: "push/y" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: x, method: "git_push" });
    await s.link({ session: "s1", artifactId: y, method: "gh_pr_create" });
    await s.tokens("s1", 200);

    const agg = await readBranchTokenAggregateRows(db.prisma);
    assert.deepEqual(branchNames(agg), ["push/x", "push/y"]);
    const byBranch = new Map(agg.map((r) => [r.branchName, r]));
    assert.equal(byBranch.get("push/x")?.inputTokens, 100);
    assert.equal(byBranch.get("push/y")?.inputTokens, 100);
  });
});

test("FEA-2531 AC4: read-only session → no branch row, zero tokens, link still persisted", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const a = await s.branch({ branch: "read/only" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: a, method: "git_checkout" });
    await s.tokens("s1", 100);

    assert.deepEqual(await readLocalBranchLinkRows(db.prisma), []);
    assert.deepEqual(await readDistinctBranchKeyRows(db.prisma), []);
    assert.deepEqual(await readBranchTokenAggregateRows(db.prisma), []);
    assert.deepEqual(
      await readBranchUsageTokenRows(db.prisma),
      [],
      "read-only session is out of the branch-linked usage set"
    );
    assert.equal(
      await s.countLinks("s1"),
      1,
      "the checkout link stays in session_artifact_links (stored, never shown)"
    );
  });
});

test("FEA-4311: a commit-only (session-only, unpushed) branch is visible BEFORE any push", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "push/x" });
    const y = await s.branch({ branch: "commit/y" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: x, method: "git_push" });
    await s.link({ session: "s1", artifactId: y, method: "git_commit" });
    await s.tokens("s1", 200);

    // FEA-4311 flips FEA-2531 AC5: a write-linked branch is a corpus member the
    // moment a session touches it — remote/push evidence no longer gates. So the
    // commit-only Y surfaces immediately, and s1's divisor is 2 from the start
    // (X + Y), splitting 200 → 100/100 with no push required. (Pre-FEA-4311, Y
    // was hidden and X carried the full 200 until Y was pushed.)
    const before = await readBranchTokenAggregateRows(db.prisma);
    assert.deepEqual(branchNames(before), ["commit/y", "push/x"]);
    const byBranchBefore = new Map(before.map((r) => [r.branchName, r]));
    assert.equal(byBranchBefore.get("push/x")?.inputTokens, 100);
    assert.equal(byBranchBefore.get("commit/y")?.inputTokens, 100);
    assert.deepEqual(branchNames(await readLocalBranchLinkRows(db.prisma)), [
      "commit/y",
      "push/x",
    ]);
    assert.deepEqual(branchNames(await readDistinctBranchKeyRows(db.prisma)), [
      "commit/y",
      "push/x",
    ]);

    // A later push on Y is pure enrichment — it does NOT change membership or the
    // split (Y was already visible and already counted in the divisor). No
    // double-count: Y stays a single divisor slot before and after the push.
    await s.markPushed(y, "2026-06-01T02:00:00.000Z");
    const after = await readBranchTokenAggregateRows(db.prisma);
    assert.deepEqual(branchNames(after), ["commit/y", "push/x"]);
    const byBranchAfter = new Map(after.map((r) => [r.branchName, r]));
    assert.equal(byBranchAfter.get("push/x")?.inputTokens, 100);
    assert.equal(byBranchAfter.get("commit/y")?.inputTokens, 100);
  });
});

test("FEA-4311: scoped detail read surfaces a commit-only branch before any push", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const y = await s.branch({ branch: "commit/y" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: y, method: "git_commit" });
    await s.tokens("s1", 100);

    // The single-branch detail reader (`readLocalBranchLinkRowsForBranch`) must
    // apply the SAME widened membership as the list — a URL straight to an
    // unpushed, session-only branch resolves rather than reading empty.
    const detailRows = await readLocalBranchLinkRowsForBranch(db.prisma, {
      repoFullName: "acme/web",
      branchName: "commit/y",
    });
    assert.deepEqual(branchNames(detailRows), ["commit/y"]);
  });
});

test("ISS-5828: raw default evidence survives while the eligible divisor excludes it", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const main = await s.branch({ branch: "main" });
    const feat = await s.branch({ branch: "feature/x" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: main, method: "git_push" });
    await s.link({ session: "s1", artifactId: feat, method: "git_push" });
    await s.tokens("s1", 200);

    // Raw evidence retains both branches for diagnostics and default changes.
    assert.deepEqual(branchNames(await readLocalBranchLinkRows(db.prisma)), [
      "feature/x",
      "main",
    ]);
    assert.deepEqual(branchNames(await readDistinctBranchKeyRows(db.prisma)), [
      "feature/x",
      "main",
    ]);

    // Product aggregation receives the authoritative eligible corpus before
    // computing its divisor, so the feature receives the full session total.
    const agg = await readBranchTokenAggregateRows(db.prisma, [
      { repoFullName: "acme/web", branchName: "feature/x" },
    ]);
    const feature = agg.find((r) => r.branchName === "feature/x");
    assert.equal(feature?.inputTokens, 200);
    assert.equal(
      agg.some((row) => row.branchName === "main"),
      false
    );
  });
});

test("FEA-2531 AC9: workspace-relation (pre-reparse) and created-relation rows read identically", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    // Two independent sessions running the SAME active-write scenario, differing
    // only in `relation`. The method-based predicates must not distinguish them.
    const ws = await s.branch({ branch: "rel/workspace" });
    const cr = await s.branch({ branch: "rel/created" });
    await s.session("sWs");
    await s.session("sCr");
    await s.link({
      session: "sWs",
      artifactId: ws,
      method: "git_push",
      relation: "workspace",
    });
    await s.link({
      session: "sCr",
      artifactId: cr,
      method: "git_push",
      relation: "created",
    });
    await s.tokens("sWs", 100);
    await s.tokens("sCr", 100);

    const agg = await readBranchTokenAggregateRows(db.prisma);
    const byBranch = new Map(agg.map((r) => [r.branchName, r.inputTokens]));
    assert.equal(byBranch.get("rel/workspace"), 100);
    assert.equal(
      byBranch.get("rel/created"),
      byBranch.get("rel/workspace"),
      "relation does not change the read outcome"
    );
    assert.deepEqual(branchNames(await readLocalBranchLinkRows(db.prisma)), [
      "rel/created",
      "rel/workspace",
    ]);
  });
});
