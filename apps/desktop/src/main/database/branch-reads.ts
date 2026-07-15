import {
  defaultBranchSqlList,
  isDefaultBranchName,
} from "../enrichment/default-branch-names.js";
import { readStorageTokenCount } from "../token-counts.js";
import {
  BRANCH_PUSH_METHOD_VALUES,
  BRANCH_WRITE_METHOD_VALUES,
  sqlStringList,
} from "./db-constants.js";
import type { DbHostPrisma } from "./prisma-client.js";

// FEA-2531 method-value lists as SQL string-literal fragments, built from the
// `db-constants` tuples so raw reads never inline a method string.
const BRANCH_WRITE_METHOD_SQL = sqlStringList(BRANCH_WRITE_METHOD_VALUES);
const BRANCH_PUSH_METHOD_SQL = sqlStringList(BRANCH_PUSH_METHOD_VALUES);

/** Push-evidence SQL predicate for a branch artifact aliased `artifactAlias`. */
function branchPushEvidenceSql(artifactAlias: string): string {
  return `(EXISTS (
        SELECT 1 FROM session_artifact_links sal_push
        WHERE sal_push.artifact_id = ${artifactAlias}.id
          AND sal_push.method IN (${BRANCH_PUSH_METHOD_SQL})
      ) OR ${artifactAlias}.first_pushed_at IS NOT NULL)`;
}

/**
 * Active-write-link SQL predicate: write-method link AND push-qualified branch.
 * The even-split divisor does NOT apply the default-branch exclusion — that is
 * display-only (a pushed `main` still counts in a session's denominator). AC7.
 */
function activeWriteLinkSql(linkAlias: string, artifactAlias: string): string {
  return `${linkAlias}.method IN (${BRANCH_WRITE_METHOD_SQL})
        AND ${branchPushEvidenceSql(artifactAlias)}`;
}

/**
 * Prisma-typed push-evidence filter for branch artifact where clauses. Shared by
 * the three typed reads so the display gate's push half cannot drift between them.
 */
function branchPushEvidenceFilter(): {
  OR: {
    artifactLinks?: { some: { method: { in: string[] } } };
    firstPushedAt?: { not: null };
  }[];
} {
  return {
    OR: [
      {
        artifactLinks: {
          some: { method: { in: [...BRANCH_PUSH_METHOD_VALUES] } },
        },
      },
      { firstPushedAt: { not: null } },
    ],
  };
}

/**
 * Local SQLite read layer for the Branches serving ops (FEA-1948 / Epic B B1).
 *
 * Since FEA-1899 a "branch" is a row in the `artifacts` table (`kind='branch'`,
 * carrying `repo_full_name`/`branch_name` plus the GitHub enrichment columns);
 * `session_artifact_links` became a pure join (`session_id` ↔ `artifact_id`). So
 * these reads JOIN `artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'`
 * to recover the sessions that worked each branch. PR metadata still comes from
 * `pull_requests`; token cost from `token_usage` joined back through the link
 * table. The FEA-1899 enrichment columns on `artifacts` (`lines_added` /
 * `lines_removed` / `files_changed`) ARE now surfaced: the link read carries the
 * branch artifact's net LOC (null until the branch is enriched — never 0), which
 * the list / detail / analytics projections expose as `additions` / `deletions`
 * / `filesChanged`. The remaining GitHub-only columns (base ref, checks, review
 * decision, ahead/behind) still have no local producer and stay `null`.
 *
 * Every function takes the read-only `DbHostPrisma` client (prisma.client). The reads split by
 * whether the SQL has a clean typed-delegate form:
 *
 * - TYPED delegates (preferred — `prisma.client.<model>.findMany`):
 *   `readLocalBranchLinkRows` (link → branch artifact + session, COALESCE folded
 *   in JS), `readDistinctBranchKeyRows` (`distinct` on the branch artifact key),
 *   and `readBranchUsageTokenRows` (two keyed reads — branch-linked sessions via
 *   the link table's `session` relation, then their `token_usage` rows by
 *   `sessionId IN (…)` — joined in JS, since `token_usage` has no session
 *   relation to model without drifting the migration). Typed Int columns come
 *   back as JS `number`/`bigint` directly, so no per-row coercion is needed
 *   beyond the existing `tokenCount` (bigint → number) boundary.
 *
 * - RAW reads on the read-only `prisma.client.$queryRawUnsafe` escape hatch,
 *   each because it has no clean typed form (NOT as a shortcut):
 *   `readLocalBranchPrRows` (value-based `(repo, branch)` match with null-safe
 *   `IS NOT DISTINCT FROM` — `pull_requests` has no key relation to artifacts),
 *   `readLocalBranchCommitRows` (`DISTINCT` self-join across the link table via a
 *   shared session), `readBranchTokenAggregateRows` (`SUM … GROUP BY` over a
 *   fan-out join whose group keys come from the joined artifact, which Prisma
 *   `groupBy` cannot express), and `readBranchUsageEventRows` (`token_events` is
 *   `@@ignore`'d — no primary key, so it is excluded from the generated client
 *   and can never be a typed delegate). These run on the one client; integer
 *   columns are `Number()`-coerced at the boundary because the Prisma raw path
 *   can surface them as `bigint`.
 *
 * The serving op still issues a small bounded set of grouped reads (no per-branch
 * fan-out), mirroring the O(grouped) discipline of `aggregateSqliteUsage`.
 */

/** One `session_artifact_links` row that names a branch (branch_name non-null). */
export type BranchLinkRow = {
  repoFullName: string | null;
  branchName: string;
  sessionId: string;
  isPrimary: boolean;
  /** When the link was *observed/scanned* (wall-clock import time). */
  observedAt: string;
  /**
   * The linked session's real last-activity time — `ended_at`, else
   * `started_at`, both derived from the transcript turns (NOT scan time). Used
   * to age the branch in the list; falls back to `observedAt` only when a
   * session somehow has no turn timestamps. See FEA-2022.
   */
  activityAt: string;
  /**
   * Net branch LOC from FEA-1899 enrichment, read off the joined branch artifact
   * (`kind='branch'`). Identical across a branch's link rows (the value lives on
   * the one branch artifact); `null` until the branch is enriched — never
   * 0-as-unknown. Surfaced as `additions` / `deletions` / `filesChanged`.
   */
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
};

/** One `pull_requests` row keyed to a branch (branch_name non-null). */
export type BranchPrRow = {
  repoFullName: string | null;
  branchName: string;
  prNumber: number | null;
  prUrl: string | null;
  title: string | null;
  state: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  /** GitHub PR createdAt (PRD-486) — the PR-opened lifecycle dot; null until enriched. */
  openedAt: string | null;
  observedAt: string | null;
  /**
   * LOC from the matching PR artifact's FEA-1899 enrichment (the
   * `kind='pull_request'` row in `artifacts`, joined by `(repo, pr_number)`).
   * This is the SAME source the delivery dashboard medians (FEA-2159): branch
   * artifacts are often un-enriched while their merged PR artifact carries LOC,
   * so the list projection falls back to these when the branch's own LOC is
   * null. `null` until the PR artifact is enriched — never 0-as-unknown.
   */
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
};

/**
 * One commit linked to a branch through its sessions — the rail's per-commit
 * dots (PRD-486). A commit is a `kind='commit'` artifact captured event-time from
 * the session transcript; it reaches a branch via the sessions that touched both.
 */
export type BranchCommitRow = {
  repoFullName: string | null;
  branchName: string;
  sha: string;
  /** The commit's real time (transcript event time at capture, not scan time). */
  committedAt: string;
  /** Commit subject (stored in artifacts.title); null when not captured. */
  message: string | null;
};

/** Per-`(branch, model)` token totals — the grouped input to `costPerBranch`. */
export type BranchTokenAggregateRow = {
  repoFullName: string | null;
  branchName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /**
   * Captured cost (`SUM(token_usage.cost_usd_estimated)`) for this `(branch,
   * model)` group — `null` when no row in the group was priced. Drives the
   * per-branch cost shown on the list, mirroring the dashboard's stored-cost
   * basis rather than re-deriving list price from the token counts above.
   */
  costUsdEstimated: number | null;
};

/** Per-`(session, model)` token row for branch-linked sessions (usage rollup). */
export type BranchUsageTokenRow = {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  billingMode: string | null;
  createdAt: string | null;
  /**
   * Captured per-row cost (`token_usage.cost_usd_estimated`) — the SAME stored
   * figure the agent dashboard sums. `null` for rows the pricing pipeline never
   * costed (subscription / un-priced models); branch spend treats those as $0 so
   * it reconciles with the dashboard instead of re-deriving list price. Event
   * rows (`readBranchUsageEventRows`) carry `null` — token_events has no cost.
   */
  costUsdEstimated: number | null;
};

/** The selected shape both link reads (global + branch-scoped) project from. */
type BranchLinkSelectRow = {
  sessionId: string;
  isPrimary: boolean;
  observedAt: string;
  artifact: {
    repoFullName: string | null;
    branchName: string | null;
    linesAdded: number | null;
    linesRemoved: number | null;
    filesChanged: number | null;
  };
  session: { endedAt: string | null; startedAt: string | null };
};

/**
 * Shared narrow/COALESCE mapper for the link reads, so the global
 * `readLocalBranchLinkRows` and the branch-scoped
 * `readLocalBranchLinkRowsForBranch` can never drift in how they derive a
 * `BranchLinkRow` from the selected columns.
 */
function mapBranchLinkRows(rows: BranchLinkSelectRow[]): BranchLinkRow[] {
  return rows.flatMap((row) => {
    const { branchName } = row.artifact;
    // Default-branch exclusion is display-only (AC7: a pushed default branch
    // still counts in the token-split denominator, it just never lists).
    if (branchName === null || isDefaultBranchName(branchName)) {
      return [];
    }
    return [
      {
        repoFullName: row.artifact.repoFullName,
        branchName,
        sessionId: row.sessionId,
        isPrimary: row.isPrimary,
        observedAt: row.observedAt,
        linesAdded: row.artifact.linesAdded,
        linesRemoved: row.artifact.linesRemoved,
        filesChanged: row.artifact.filesChanged,
        // `activity_at` is the linked session's real last-activity time
        // (ended/started, from the transcript turns) — NOT `observed_at`,
        // the wall-clock time the importer last *scanned* the link, which
        // reads "just now" on every re-import (FEA-2022). `??` matches SQL
        // COALESCE(s.ended_at, s.started_at, sal.observed_at): it falls
        // through on NULL only (an empty string is kept), and falls back to
        // observed_at if a session has neither timestamp.
        activityAt:
          row.session.endedAt ?? row.session.startedAt ?? row.observedAt,
      },
    ];
  });
}

/**
 * Branch-naming link rows. Grouped in memory by `(repoFullName, branchName)` to
 * recover each branch's session set + most-recent `observed_at`.
 */
export function readLocalBranchLinkRows(
  prisma: DbHostPrisma
): Promise<BranchLinkRow[]> {
  // A branch is an `artifacts` row with kind='branch' (ArtifactRefTargetKind
  // .Branch); the link table joins it to the sessions that worked it. Only
  // branch artifacts define a branch, so a PR/commit artifact can't inflate the
  // list or usage. The `session` relation is the link's FK to `sessions` (a real
  // DB FK with cascade), so the nested select never drops a wanted row.
  return prisma.client.sessionArtifactLink
    .findMany({
      // Write-method links only; push evidence on the artifact; non-default
      // half applied in `mapBranchLinkRows`.
      where: {
        method: { in: [...BRANCH_WRITE_METHOD_VALUES] },
        artifact: {
          kind: "branch",
          branchName: { not: null },
          ...branchPushEvidenceFilter(),
        },
      },
      select: {
        sessionId: true,
        isPrimary: true,
        observedAt: true,
        artifact: {
          select: {
            repoFullName: true,
            branchName: true,
            linesAdded: true,
            linesRemoved: true,
            filesChanged: true,
          },
        },
        session: { select: { endedAt: true, startedAt: true } },
      },
      orderBy: [{ artifact: { branchName: "asc" } }, { observedAt: "desc" }],
    })
    .then(mapBranchLinkRows);
}

/** A distinct `(repo_full_name, branch_name)` branch key. */
export type BranchKeyRow = {
  repoFullName: string | null;
  branchName: string;
};

/**
 * The DISTINCT `(repo_full_name, branch_name)` pairs — a leaner read than
 * `readLocalBranchLinkRows` when only the branch COUNT is needed (the usage
 * rollup), so it doesn't materialize every link row. The engine collapses
 * duplicate pairs (NULL repo included); the caller counts via `encodeBranchId`
 * so null-repo collapsing matches the list projection byte-for-byte.
 *
 * `artifactLinks: { some: {} }` reproduces the inner JOIN against the link
 * table — a branch artifact with no session links never appears — while
 * `distinct` collapses multiple branch artifacts that share a `(repo, branch)`
 * key the same way the SQL `DISTINCT` did.
 */
export function readDistinctBranchKeyRows(
  prisma: DbHostPrisma
): Promise<BranchKeyRow[]> {
  return prisma.client.artifact
    .findMany({
      // Same write + push evidence gate as `readLocalBranchLinkRows`;
      // non-default half applied below.
      where: {
        kind: "branch",
        branchName: { not: null },
        artifactLinks: {
          some: { method: { in: [...BRANCH_WRITE_METHOD_VALUES] } },
        },
        ...branchPushEvidenceFilter(),
      },
      select: { repoFullName: true, branchName: true },
      distinct: ["repoFullName", "branchName"],
    })
    .then((rows) =>
      rows.flatMap((row) =>
        row.branchName === null || isDefaultBranchName(row.branchName)
          ? []
          : [{ repoFullName: row.repoFullName, branchName: row.branchName }]
      )
    );
}

/** The raw PR-row shape both PR reads (global + branch-scoped) map. */
type BranchPrRawRow = {
  repo_full_name: string | null;
  branch_name: string;
  pr_number: number | bigint | null;
  pr_url: string | null;
  title: string | null;
  state: string | null;
  merged_at: string | null;
  closed_at: string | null;
  opened_at: string | null;
  observed_at: string | null;
  lines_added: number | bigint | null;
  lines_removed: number | bigint | null;
  files_changed: number | bigint | null;
};

/**
 * Shared bigint→number coercion for the PR reads, so the global
 * `readLocalBranchPrRows` and the branch-scoped `readLocalBranchPrRowsForBranch`
 * cannot drift in how they surface PR artifact LOC.
 */
function mapBranchPrRawRows(rows: BranchPrRawRow[]): BranchPrRow[] {
  return rows.map((row) => ({
    repoFullName: row.repo_full_name,
    branchName: row.branch_name,
    // Number()-coerce: the Prisma raw path can return INTEGER as bigint.
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
    prUrl: row.pr_url,
    title: row.title,
    state: row.state,
    mergedAt: row.merged_at,
    closedAt: row.closed_at,
    openedAt: row.opened_at,
    observedAt: row.observed_at,
    linesAdded: row.lines_added == null ? null : Number(row.lines_added),
    linesRemoved: row.lines_removed == null ? null : Number(row.lines_removed),
    filesChanged: row.files_changed == null ? null : Number(row.files_changed),
  }));
}

/**
 * PR rows keyed by branch, newest `observed_at` first within each branch.
 *
 * Scoped through `session_artifact_links → artifacts(kind='branch')` like the
 * sibling reads, so it never returns PRs for branches with no branch artifact
 * (a webhook/direct-write/future-enrichment path could populate `pull_requests`
 * outside session import; without this guard those rows would leak the file's
 * session-scoping invariant). Match is on `(repo_full_name, branch_name)` — the
 * same identity `encodeBranchId` keys on — with `IS NOT DISTINCT FROM` so a
 * NULL repo matches a NULL repo.
 *
 * Ordered observed_at DESC, then pr_number DESC as a deterministic tiebreaker:
 * the v1 local parser may leave observed_at null, and without the secondary key
 * a branch whose PRs all have null observed_at would yield an engine-dependent
 * "latest PR" (the projection takes `[0]` as the displayed PR).
 */
export function readLocalBranchPrRows(
  prisma: DbHostPrisma
): Promise<BranchPrRow[]> {
  return prisma.client
    .$queryRawUnsafe<BranchPrRawRow[]>(
      // The PR artifact's FEA-1899 LOC (`kind='pull_request'`) is joined in by
      // `(repo, pr_number)` so the Branches list can surface PR size even when
      // the branch artifact itself is un-enriched — the same enriched source the
      // delivery dashboard medians (FEA-2159). The join target is pre-grouped to
      // ONE row per `(repo, pr_number)` (MAX folds the identical/least-null LOC)
      // so it can never fan a `pull_requests` row out into duplicate PR rows.
      `SELECT pr.repo_full_name, pr.branch_name, pr.pr_number, pr.pr_url,
              pr.title, pr.state, pr.merged_at, pr.closed_at, pr.opened_at,
              pr.observed_at,
              pra.lines_added, pra.lines_removed, pra.files_changed
       FROM pull_requests pr
       LEFT JOIN (
         SELECT repo_full_name, pr_number,
                MAX(lines_added) AS lines_added,
                MAX(lines_removed) AS lines_removed,
                MAX(files_changed) AS files_changed
         FROM artifacts
         WHERE kind = 'pull_request' AND pr_number IS NOT NULL
         GROUP BY repo_full_name, pr_number
       ) pra ON pra.pr_number = pr.pr_number
            AND pra.repo_full_name IS NOT DISTINCT FROM pr.repo_full_name
       WHERE pr.branch_name IS NOT NULL
         -- FEA-2260: intentionally blanket-excludes default-branch PRs (deploy
         -- PRs like main→production). The migration preserves cross-fork rows
         -- in the DB for data integrity, but the Branches UI hides them.
         AND pr.branch_name NOT IN (${defaultBranchSqlList()})
         -- Push-evidence gate: PRs only appear for push-qualified branches.
         AND EXISTS (
           SELECT 1
           FROM session_artifact_links sal
           JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
           WHERE a.branch_name = pr.branch_name
             AND a.repo_full_name IS NOT DISTINCT FROM pr.repo_full_name
             AND ${branchPushEvidenceSql("a")}
         )
       ORDER BY pr.branch_name ASC, pr.observed_at DESC NULLS LAST,
                pr.pr_number DESC NULLS LAST`
    )
    .then(mapBranchPrRawRows);
}

/**
 * Commit rows per branch — the rail's per-commit dots (PRD-486). A commit
 * (`kind='commit'`) is linked only to the sessions that ran it; it reaches a
 * branch through a session that ALSO touched that branch's artifact, mirroring
 * the EXISTS-scoping discipline of `readLocalBranchPrRows`. Only commits with a
 * captured `committed_at` are returned (event-time capture); SHA-only legacy
 * rows that predate PRD-486 are skipped so they never render a dot at epoch 0.
 *
 * Attribution is via session membership: a session linked to multiple branches
 * contributes its commits to each (rare, accepted for v1 — same caveat as the
 * token rollup). `DISTINCT` collapses the duplicate (branch, commit) pairs the
 * double join would otherwise produce.
 */
export function readLocalBranchCommitRows(
  prisma: DbHostPrisma
): Promise<BranchCommitRow[]> {
  return prisma.client
    .$queryRawUnsafe<
      {
        repo_full_name: string | null;
        branch_name: string;
        sha: string;
        committed_at: string;
        message: string | null;
      }[]
    >(
      // Active-write links + non-default gate, matching the list's branch set.
      `SELECT DISTINCT b.repo_full_name, b.branch_name,
              c.sha, c.committed_at, c.title AS message
       FROM session_artifact_links sal_b
       JOIN artifacts b ON b.id = sal_b.artifact_id AND b.kind = 'branch'
       JOIN session_artifact_links sal_c ON sal_c.session_id = sal_b.session_id
       JOIN artifacts c ON c.id = sal_c.artifact_id AND c.kind = 'commit'
       WHERE b.branch_name IS NOT NULL
         AND b.branch_name NOT IN (${defaultBranchSqlList()})
         AND ${activeWriteLinkSql("sal_b", "b")}
         AND c.sha IS NOT NULL
         AND c.committed_at IS NOT NULL
       ORDER BY b.branch_name ASC, c.committed_at ASC`
    )
    .then((rows) =>
      rows.map((row) => ({
        repoFullName: row.repo_full_name,
        branchName: row.branch_name,
        sha: row.sha,
        committedAt: row.committed_at,
        message: row.message,
      }))
    );
}

/** The raw aggregate-row shape both token reads (global + branch-scoped) map. */
type BranchTokenAggregateRawRow = {
  repo_full_name: string | null;
  branch_name: string;
  model: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  cost_usd_estimated: number | null;
};

/**
 * Shared bigint→number coercion + cost-null mapper for the token aggregate
 * reads, so the global `readBranchTokenAggregateRows` and the branch-scoped
 * `readBranchTokenAggregateRowsForBranch` coerce the SAME way (the raw path can
 * surface SUM()/CAST totals as `bigint`).
 */
function mapBranchTokenAggregateRows(
  rows: BranchTokenAggregateRawRow[]
): BranchTokenAggregateRow[] {
  return rows.map((row) => ({
    repoFullName: row.repo_full_name,
    branchName: row.branch_name,
    model: row.model,
    inputTokens: tokenCount(row.input_tokens, "branch.input_tokens"),
    outputTokens: tokenCount(row.output_tokens, "branch.output_tokens"),
    cacheReadTokens: tokenCount(
      row.cache_read_tokens,
      "branch.cache_read_tokens"
    ),
    cacheWriteTokens: tokenCount(
      row.cache_write_tokens,
      "branch.cache_write_tokens"
    ),
    costUsdEstimated:
      row.cost_usd_estimated == null ? null : Number(row.cost_usd_estimated),
  }));
}

/**
 * Per-`(branch, model)` token totals. A two-stage CTE deduplicates
 * session↔branch pairs first, then counts branches per session over the
 * deduplicated set — a single grouped query, no per-branch fan-out.
 *
 * ATTRIBUTION (fractional, FEA-2032 + FEA-2531): both the deduped `d` set and
 * the `branch_count` divisor keep only a session's ACTIVE WRITE links
 * (write-method link on a push-qualified branch), so a session linked to N
 * distinct active-write branches contributes `tokenTotal / N` to each
 * (integer-truncated via CAST(... AS INTEGER) to satisfy readStorageTokenCount's
 * integer contract). Read-only links never enter the split, and the divisor does
 * NOT apply the default-branch exclusion — a pushed `main` still counts in N even
 * though it never lists (AC7). Truncation is directionally conservative:
 * per-branch totals may sum to slightly less than the session total for odd
 * splits, never more.
 */
export function readBranchTokenAggregateRows(
  prisma: DbHostPrisma
): Promise<BranchTokenAggregateRow[]> {
  return prisma.client
    .$queryRawUnsafe<BranchTokenAggregateRawRow[]>(
      // Captured cost is split across branches the SAME way the tokens are
      // (FEA-2032 even-split), so a multi-branch session's stored cost divides by
      // `branch_count` per branch and the per-branch costs sum back to the
      // session's once. `SUM(… / …)` over NULL costs yields NULL (group never
      // priced), surfaced as a null per-branch cost rather than a misleading $0.
      `SELECT
         l.repo_full_name AS repo_full_name,
         l.branch_name AS branch_name,
         t.model AS model,
         CAST(SUM(COALESCE(t.input_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS input_tokens,
         CAST(SUM(COALESCE(t.output_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS output_tokens,
         CAST(SUM(COALESCE(t.cache_read_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS cache_read_tokens,
         CAST(SUM(COALESCE(t.cache_write_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS cache_write_tokens,
         SUM(t.cost_usd_estimated / CAST(l.branch_count AS REAL)) AS cost_usd_estimated
       FROM token_usage t
       JOIN (
         SELECT d.session_id, d.repo_full_name, d.branch_name,
                (SELECT COUNT(*) FROM (
                   SELECT DISTINCT sal2.session_id, a2.repo_full_name, a2.branch_name
                   FROM session_artifact_links sal2
                   JOIN artifacts a2 ON a2.id = sal2.artifact_id AND a2.kind = 'branch'
                   WHERE a2.branch_name IS NOT NULL AND sal2.session_id = d.session_id
                     AND ${activeWriteLinkSql("sal2", "a2")}
                )) AS branch_count
         FROM (
           SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
           FROM session_artifact_links sal
           JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
           WHERE a.branch_name IS NOT NULL
             AND ${activeWriteLinkSql("sal", "a")}
         ) d
       ) l ON l.session_id = t.session_id
       GROUP BY l.repo_full_name, l.branch_name, t.model
       ORDER BY l.branch_name ASC, t.model ASC`
    )
    .then(mapBranchTokenAggregateRows);
}

// ---------------------------------------------------------------------------
// Branch-SCOPED detail reads (PLN-1148, Phase 1).
//
// The list/usage/analytics ops above read the WHOLE local corpus and group in
// memory; the single-branch DETAIL page does not need that. These variants push
// the `(repoFullName, branchName)` identity (or the branch's already-resolved
// session-id set) into the WHERE/CTE so the detail's cost scales with the opened
// branch, not the total local history. Each is an exact single-branch equivalent
// of its global sibling filtered to one `encodeBranchId` — see
// `getSharedBranchDetail`. `repoFullName: null` is matched null-safely so the
// repo-less branch key collapses identically to the list projection.
// ---------------------------------------------------------------------------

/**
 * The branch's link rows — the single-branch analogue of
 * `readLocalBranchLinkRows`. The `(repoFullName, branchName)` predicate is served
 * by the partial `idx_artifacts_branch` index (kind='branch'). Newest-observed
 * first so the projection's per-session dedup keeps the right primary/first link.
 */
export function readLocalBranchLinkRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchKeyRow
): Promise<BranchLinkRow[]> {
  return prisma.client.sessionArtifactLink
    .findMany({
      // Same display gate as `readLocalBranchLinkRows`, scoped to one branch.
      where: {
        method: { in: [...BRANCH_WRITE_METHOD_VALUES] },
        artifact: {
          kind: "branch",
          branchName: key.branchName,
          repoFullName: key.repoFullName,
          ...branchPushEvidenceFilter(),
        },
      },
      select: {
        sessionId: true,
        isPrimary: true,
        observedAt: true,
        artifact: {
          select: {
            repoFullName: true,
            branchName: true,
            linesAdded: true,
            linesRemoved: true,
            filesChanged: true,
          },
        },
        session: { select: { endedAt: true, startedAt: true } },
      },
      // One branch → the global read's `branchName ASC` is moot; keep the
      // `observedAt DESC` tiebreak the per-session dedup relies on.
      orderBy: [{ observedAt: "desc" }],
    })
    .then(mapBranchLinkRows);
}

/**
 * The branch's PR rows — the single-branch analogue of `readLocalBranchPrRows`.
 *
 * The global read EXISTS-scopes PRs through a branch artifact to uphold the
 * session-scoping invariant; the detail does not need that guard because it only
 * reaches this read for a branch that already has link rows (the detail 404s
 * otherwise), so a `(repo, branch)`-keyed read is exact AND cheaper. This still
 * joins the PR artifact's LOC by `(repo, pr_number)`, matching the global read.
 * Ordered newest-observed first (SQLite sorts NULLs last under DESC, matching
 * the global read's explicit `NULLS LAST`) so the projection's `[0]` is the
 * displayed PR.
 */
export function readLocalBranchPrRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchKeyRow
): Promise<BranchPrRow[]> {
  return prisma.client
    .$queryRawUnsafe<BranchPrRawRow[]>(
      `SELECT pr.repo_full_name, pr.branch_name, pr.pr_number, pr.pr_url,
              pr.title, pr.state, pr.merged_at, pr.closed_at, pr.opened_at,
              pr.observed_at,
              pra.lines_added, pra.lines_removed, pra.files_changed
       FROM pull_requests pr
       LEFT JOIN (
         SELECT repo_full_name, pr_number,
                MAX(lines_added) AS lines_added,
                MAX(lines_removed) AS lines_removed,
                MAX(files_changed) AS files_changed
         FROM artifacts
         WHERE kind = 'pull_request' AND pr_number IS NOT NULL
         GROUP BY repo_full_name, pr_number
       ) pra ON pra.pr_number = pr.pr_number
            AND pra.repo_full_name IS NOT DISTINCT FROM pr.repo_full_name
       WHERE pr.branch_name = ?
         AND pr.branch_name NOT IN (${defaultBranchSqlList()})
         AND pr.repo_full_name IS NOT DISTINCT FROM ?
       ORDER BY pr.observed_at DESC NULLS LAST, pr.pr_number DESC NULLS LAST`,
      key.branchName,
      key.repoFullName
    )
    .then(mapBranchPrRawRows);
}

/**
 * The branch's per-commit rail dots — the single-branch analogue of
 * `readLocalBranchCommitRows`. Scoped through the branch's already-resolved
 * session set (served by `idx_sal_session`), then narrowed to commit artifacts.
 * A commit linked via more than one of the branch's sessions is de-duplicated by
 * `sha`. `repoFullName`/`branchName` are stamped from the branch key because the
 * global read projects the BRANCH's identity onto each commit row, not the commit
 * artifact's own repo. Returned oldest-committed first, matching the global
 * read's `ORDER BY committed_at ASC` (ISO-8601 text sorts chronologically).
 */
export function readBranchCommitRowsForSessions(
  prisma: DbHostPrisma,
  sessionIds: readonly string[],
  key: BranchKeyRow
): Promise<BranchCommitRow[]> {
  if (sessionIds.length === 0) {
    return Promise.resolve([]);
  }
  return prisma.client.sessionArtifactLink
    .findMany({
      where: {
        sessionId: { in: [...new Set(sessionIds)] },
        artifact: {
          kind: "commit",
          sha: { not: null },
          committedAt: { not: null },
        },
      },
      select: {
        artifact: { select: { sha: true, committedAt: true, title: true } },
      },
    })
    .then((rows) => {
      const bySha = new Map<string, BranchCommitRow>();
      for (const { artifact } of rows) {
        const { sha, committedAt } = artifact;
        // where-filtered non-null; narrow for the BranchCommitRow contract and
        // collapse a commit reached via more than one of the branch's sessions.
        if (sha === null || committedAt === null || bySha.has(sha)) {
          continue;
        }
        bySha.set(sha, {
          repoFullName: key.repoFullName,
          branchName: key.branchName,
          sha,
          committedAt,
          message: artifact.title,
        });
      }
      // ISO-8601 text sorts chronologically, matching the global read's
      // `ORDER BY committed_at ASC` (a plain SQL text sort).
      return [...bySha.values()].sort((a, b) =>
        a.committedAt.localeCompare(b.committedAt)
      );
    });
}

/**
 * The branch's per-`(model)` token totals — the single-branch analogue of
 * `readBranchTokenAggregateRows`.
 *
 * CRITICAL (FEA-2032 + FEA-2531): the even-split denominator (`branch_count`) is
 * left GLOBAL — it counts EVERY distinct ACTIVE WRITE branch each contributing
 * session touched — so a multi-branch session's tokens divide by its FULL
 * active-write branch count, exactly as the list does. Only the OUTER branch
 * selection (`d`) is scoped to the target `(repoFullName, branchName)` (and also
 * active-write-filtered), so the engine reads just this branch's sessions'
 * `token_usage` instead of the whole table. `repo_full_name IS NOT DISTINCT FROM
 * ?` keeps the null-repo match null-safe; both branch components are BOUND
 * parameters (never interpolated) on the read-only escape hatch.
 */
export function readBranchTokenAggregateRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchKeyRow
): Promise<BranchTokenAggregateRow[]> {
  return prisma.client
    .$queryRawUnsafe<BranchTokenAggregateRawRow[]>(
      `SELECT
         l.repo_full_name AS repo_full_name,
         l.branch_name AS branch_name,
         t.model AS model,
         CAST(SUM(COALESCE(t.input_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS input_tokens,
         CAST(SUM(COALESCE(t.output_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS output_tokens,
         CAST(SUM(COALESCE(t.cache_read_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS cache_read_tokens,
         CAST(SUM(COALESCE(t.cache_write_tokens, 0) / CAST(l.branch_count AS REAL)) AS INTEGER) AS cache_write_tokens,
         SUM(t.cost_usd_estimated / CAST(l.branch_count AS REAL)) AS cost_usd_estimated
       FROM token_usage t
       JOIN (
         SELECT d.session_id, d.repo_full_name, d.branch_name,
                (SELECT COUNT(*) FROM (
                   SELECT DISTINCT sal2.session_id, a2.repo_full_name, a2.branch_name
                   FROM session_artifact_links sal2
                   JOIN artifacts a2 ON a2.id = sal2.artifact_id AND a2.kind = 'branch'
                   WHERE a2.branch_name IS NOT NULL AND sal2.session_id = d.session_id
                     AND ${activeWriteLinkSql("sal2", "a2")}
                )) AS branch_count
         FROM (
           SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
           FROM session_artifact_links sal
           JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
           WHERE a.branch_name = ?
             AND a.repo_full_name IS NOT DISTINCT FROM ?
             AND ${activeWriteLinkSql("sal", "a")}
         ) d
       ) l ON l.session_id = t.session_id
       GROUP BY l.repo_full_name, l.branch_name, t.model
       ORDER BY t.model ASC`,
      key.branchName,
      key.repoFullName
    )
    .then(mapBranchTokenAggregateRows);
}

// Sessions with an active-write link — shared subquery for usage/analytics/event reads.
const BRANCH_LINKED_SESSION_SUBQUERY = `
  SELECT DISTINCT sal.session_id
  FROM session_artifact_links sal
  JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
  WHERE a.branch_name IS NOT NULL
    AND ${activeWriteLinkSql("sal", "a")}`;

/** Raw token-usage row shape shared by both raw SQL reads below. */
type TokenUsageRawRow = {
  session_id: string;
  model: string;
  input_tokens: string | null;
  output_tokens: string | null;
  cache_read_tokens: string | null;
  cache_write_tokens: string | null;
  created_at: string | null;
  cost_usd_estimated: number | null;
};

function mapTokenUsageRawRow(
  row: TokenUsageRawRow,
  billingMode: string | null
): BranchUsageTokenRow {
  return {
    sessionId: row.session_id,
    model: row.model,
    inputTokens: tokenCount(row.input_tokens, "branch_usage.input_tokens"),
    outputTokens: tokenCount(row.output_tokens, "branch_usage.output_tokens"),
    cacheReadTokens: tokenCount(
      row.cache_read_tokens,
      "branch_usage.cache_read_tokens"
    ),
    cacheWriteTokens: tokenCount(
      row.cache_write_tokens,
      "branch_usage.cache_write_tokens"
    ),
    billingMode,
    createdAt: row.created_at,
    costUsdEstimated:
      row.cost_usd_estimated == null ? null : Number(row.cost_usd_estimated),
  };
}

/**
 * One token row per `(session, model)` for every session linked to a branch,
 * counted once. Resolves the branch-linked session set AND billing mode via a
 * single raw SQL JOIN — no `IN (…)` clause, so there is no SQLite parameter
 * limit (FEA-2260). The `sessions` JOIN carries `billing_mode` for the usage
 * summary's subscription/API billing split.
 */
export function readBranchUsageTokenRows(
  prisma: DbHostPrisma
): Promise<BranchUsageTokenRow[]> {
  return prisma.client
    .$queryRawUnsafe<(TokenUsageRawRow & { billing_mode: string | null })[]>(
      `SELECT
         tu.session_id,
         tu.model,
         tu.input_tokens,
         tu.output_tokens,
         tu.cache_read_tokens,
         tu.cache_write_tokens,
         s.billing_mode,
         tu.created_at,
         tu.cost_usd_estimated
       FROM token_usage tu
       JOIN sessions s ON s.id = tu.session_id
       WHERE tu.session_id IN (${BRANCH_LINKED_SESSION_SUBQUERY})
       ORDER BY tu.session_id ASC, tu.model ASC`
    )
    .then((rows) =>
      rows.map((row) => mapTokenUsageRawRow(row, row.billing_mode))
    );
}

/**
 * Per-`(session, model)` token rows for branch-linked sessions, without billing
 * mode (analytics path). Resolves the session set via a SQL subquery JOIN —
 * no `IN (…)` clause, so there is no SQLite parameter limit (FEA-2260).
 * Billing mode is NOT resolved — the rows carry `billingMode: null`; callers
 * that need the subscription/API split must use `readBranchUsageTokenRows`.
 */
export function readBranchAnalyticsTokenRows(
  prisma: DbHostPrisma
): Promise<BranchUsageTokenRow[]> {
  return prisma.client
    .$queryRawUnsafe<TokenUsageRawRow[]>(
      `SELECT
         tu.session_id,
         tu.model,
         tu.input_tokens,
         tu.output_tokens,
         tu.cache_read_tokens,
         tu.cache_write_tokens,
         tu.created_at,
         tu.cost_usd_estimated
       FROM token_usage tu
       WHERE tu.session_id IN (${BRANCH_LINKED_SESSION_SUBQUERY})
       ORDER BY tu.session_id ASC, tu.model ASC`
    )
    .then((rows) => rows.map((row) => mapTokenUsageRawRow(row, null)));
}

/**
 * Per-EVENT token rows (`token_events`) for branch-linked sessions, carrying the
 * real per-turn `created_at`. Unlike `readBranchUsageTokenRows` — one aggregate
 * row per `(session, model)` whose single `created_at` collapses a multi-hour
 * session into one instant — these feed the usage HOUR BUCKETS so activity lands
 * in the hour it actually happened. Same session-scope guard as the siblings.
 *
 * Totals/cost still come from the aggregate read: a session with `token_usage`
 * totals but no `token_events` (legacy/imported) simply won't appear in the
 * hourly timeline, which is preferable to mis-bucketing its whole span.
 */
export function readBranchUsageEventRows(
  prisma: DbHostPrisma
): Promise<BranchUsageTokenRow[]> {
  return prisma.client
    .$queryRawUnsafe<
      {
        session_id: string;
        model: string;
        input_tokens: string | null;
        output_tokens: string | null;
        cache_read_tokens: string | null;
        cache_write_tokens: string | null;
        billing_mode: string | null;
        created_at: string | null;
      }[]
    >(
      `SELECT
         te.session_id AS session_id,
         te.model AS model,
         COALESCE(te.input_tokens, 0) AS input_tokens,
         COALESCE(te.output_tokens, 0) AS output_tokens,
         COALESCE(te.cache_read_tokens, 0) AS cache_read_tokens,
         COALESCE(te.cache_write_tokens, 0) AS cache_write_tokens,
         s.billing_mode AS billing_mode,
         te.created_at AS created_at
       FROM token_events te
       JOIN sessions s ON s.id = te.session_id
       WHERE te.session_id IN (${BRANCH_LINKED_SESSION_SUBQUERY})
       ORDER BY te.session_id ASC, te.created_at ASC`
    )
    .then((rows) =>
      rows.map((row) => ({
        sessionId: row.session_id,
        model: row.model,
        inputTokens: tokenCount(row.input_tokens, "branch_event.input_tokens"),
        outputTokens: tokenCount(
          row.output_tokens,
          "branch_event.output_tokens"
        ),
        cacheReadTokens: tokenCount(
          row.cache_read_tokens,
          "branch_event.cache_read_tokens"
        ),
        cacheWriteTokens: tokenCount(
          row.cache_write_tokens,
          "branch_event.cache_write_tokens"
        ),
        billingMode: row.billing_mode,
        createdAt: row.created_at,
        // token_events carries no captured cost; hour buckets re-derive instead.
        costUsdEstimated: null,
      }))
    );
}

function tokenCount(value: unknown, fieldName: string): number {
  return readStorageTokenCount(value, fieldName);
}
