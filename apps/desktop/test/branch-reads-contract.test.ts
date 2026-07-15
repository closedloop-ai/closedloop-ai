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
  readLocalBranchPrRows,
} from "../src/main/database/branch-reads.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

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
    assert.equal(prs.length, 1);
    const pr = prs[0];
    assert.equal(pr.branchName, "feature/pr-enriched");
    assert.equal(pr.prNumber, 7);
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

// ---------------------------------------------------------------------------
// FEA-2531 acceptance criteria — the two-level display/attribution predicate.
//
// Every seed below uses `relation: "workspace"` on EVERY link (the pre-reparse
// shape) unless a test overrides it, proving AC9: the read predicates are
// method-based and behave identically on pre- and post-reparse rows (no
// relation-based branch in any read). Method values drive the gate:
//   - write methods (git_push / gh_pr_create / git_commit) → row-level rows;
//   - push methods  (git_push / gh_pr_create) OR `first_pushed_at` → display +
//     active-write eligibility.
// ---------------------------------------------------------------------------

const AC_T0 = "2026-06-01T00:00:00.000Z";
const AC_T1 = "2026-06-01T01:00:00.000Z";

type AcDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/** Per-db factory of terse, unique-id seed helpers for the FEA-2531 AC tests. */
function seeder(db: AcDb) {
  let n = 0;
  const uid = (prefix: string) => `${prefix}-${++n}`;
  return {
    async session(id: string): Promise<void> {
      await db.run(
        "INSERT INTO sessions (id, status, started_at, ended_at, billing_mode) VALUES ($1, 'completed', $2, $3, 'metered_api')",
        id,
        AC_T0,
        AC_T1
      );
    },
    /** A `kind='branch'` artifact; `firstPushedAt` seeds the push marker arm. */
    async branch(opts: {
      branch: string;
      repo?: string | null;
      firstPushedAt?: string | null;
    }): Promise<string> {
      const id = uid("art");
      const pushedAt = opts.firstPushedAt ?? null;
      await db.run(
        `INSERT INTO artifacts
           (id, identity_key, kind, repo_full_name, branch_name,
            first_pushed_at, push_source, created_at, last_seen_at)
         VALUES ($1, $2, 'branch', $3, $4, $5, $6, $7, $7)`,
        id,
        `ik-${id}`,
        opts.repo ?? "acme/web",
        opts.branch,
        pushedAt,
        pushedAt ? "session" : null,
        AC_T0
      );
      return id;
    },
    /** One session→branch link; `relation` defaults to the pre-reparse value. */
    async link(opts: {
      session: string;
      artifactId: string;
      method: string;
      relation?: string;
      isPrimary?: number;
    }): Promise<void> {
      const id = uid("lnk");
      await db.run(
        `INSERT INTO session_artifact_links
           (id, session_id, artifact_id, relation, method, evidence,
            is_primary, extractor_version, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'e', $6, 7, $7, $7)`,
        id,
        opts.session,
        opts.artifactId,
        opts.relation ?? "workspace",
        opts.method,
        opts.isPrimary ?? 0,
        AC_T0
      );
    },
    async tokens(session: string, input: number): Promise<void> {
      await db.run(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
         VALUES ($1, 'm1', $2, 0, 0, 0)`,
        session,
        input
      );
    },
    /** Set the push marker on an existing branch artifact (AC5 marker arm). */
    async markPushed(artifactId: string, at: string): Promise<void> {
      await db.run(
        "UPDATE artifacts SET first_pushed_at = $2, push_source = 'session' WHERE id = $1",
        artifactId,
        at
      );
    },
    async countLinks(session: string): Promise<number> {
      const rows = await db.prisma.client.$queryRawUnsafe<
        { c: number | bigint }[]
      >(
        "SELECT COUNT(*) AS c FROM session_artifact_links WHERE session_id = ?",
        session
      );
      return Number(rows[0]?.c ?? 0);
    },
  };
}

async function withAcDb(run: (db: AcDb) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "branch-reads-ac-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    emit: () => undefined,
    now: () => "2026-06-22T00:00:00.000Z",
  });
  try {
    await run(db);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function branchNames(rows: { branchName: string }[]): string[] {
  return rows.map((r) => r.branchName).sort();
}

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

test("FEA-2531 AC5: commit-only branch hidden until the push marker (first_pushed_at) arrives", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "push/x" });
    const y = await s.branch({ branch: "commit/y" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: x, method: "git_push" });
    await s.link({ session: "s1", artifactId: y, method: "git_commit" });
    await s.tokens("s1", 200);

    // Commit-only Y has a write link but NO push evidence → hidden; all 200 to X.
    const before = await readBranchTokenAggregateRows(db.prisma);
    assert.deepEqual(branchNames(before), ["push/x"]);
    assert.equal(before[0].inputTokens, 200);
    assert.deepEqual(branchNames(await readLocalBranchLinkRows(db.prisma)), [
      "push/x",
    ]);

    // Push evidence arrives on Y (marker arm) → Y activates retroactively: X's
    // divisor becomes 2, so the split flips from 100% X to 50/50.
    await s.markPushed(y, "2026-06-01T02:00:00.000Z");
    const after = await readBranchTokenAggregateRows(db.prisma);
    assert.deepEqual(branchNames(after), ["commit/y", "push/x"]);
    const byBranch = new Map(after.map((r) => [r.branchName, r]));
    assert.equal(byBranch.get("push/x")?.inputTokens, 100);
    assert.equal(byBranch.get("commit/y")?.inputTokens, 100);
    assert.deepEqual(branchNames(await readLocalBranchLinkRows(db.prisma)), [
      "commit/y",
      "push/x",
    ]);
  });
});

test("FEA-2531 AC5: commit-only branch hidden until a push link arrives from ANOTHER session", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const x = await s.branch({ branch: "push/x" });
    const y = await s.branch({ branch: "commit/y" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: x, method: "git_push" });
    await s.link({ session: "s1", artifactId: y, method: "git_commit" });
    await s.tokens("s1", 200);

    const before = await readBranchTokenAggregateRows(db.prisma);
    assert.deepEqual(branchNames(before), ["push/x"]);
    assert.equal(before[0].inputTokens, 200);

    // A DIFFERENT session pushes Y (push-method link on the same branch artifact)
    // → Y gains push evidence, activating s1's commit-only link retroactively.
    await s.session("s2");
    await s.link({ session: "s2", artifactId: y, method: "git_push" });
    await s.tokens("s2", 0);

    const after = await readBranchTokenAggregateRows(db.prisma);
    assert.deepEqual(branchNames(after), ["commit/y", "push/x"]);
    const byBranch = new Map(after.map((r) => [r.branchName, r]));
    // s1's 200 now splits across X and Y (divisor 2); s2 has no tokens.
    assert.equal(byBranch.get("push/x")?.inputTokens, 100);
    assert.equal(byBranch.get("commit/y")?.inputTokens, 100);
  });
});

test("FEA-2531 AC7: pushed default branch never lists but still counts in the divisor", async () => {
  await withAcDb(async (db) => {
    const s = seeder(db);
    const main = await s.branch({ branch: "main" });
    const feat = await s.branch({ branch: "feature/x" });
    await s.session("s1");
    await s.link({ session: "s1", artifactId: main, method: "git_push" });
    await s.link({ session: "s1", artifactId: feat, method: "git_push" });
    await s.tokens("s1", 200);

    // Display exclusion: main never lists even though it was pushed.
    assert.deepEqual(branchNames(await readLocalBranchLinkRows(db.prisma)), [
      "feature/x",
    ]);
    assert.deepEqual(branchNames(await readDistinctBranchKeyRows(db.prisma)), [
      "feature/x",
    ]);

    // Attribution still counts main in the divisor: feature/x gets 200/2 = 100,
    // NOT 200. (If the default exclusion leaked into the denominator, it'd be 200.)
    const agg = await readBranchTokenAggregateRows(db.prisma);
    const feature = agg.find((r) => r.branchName === "feature/x");
    assert.equal(
      feature?.inputTokens,
      100,
      "share reflects the main-inclusive split"
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
