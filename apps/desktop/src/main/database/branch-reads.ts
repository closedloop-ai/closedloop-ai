import type { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import type { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type {
  TokenCostSummary,
  TokenSourceIdentity,
} from "@repo/api/src/types/token-cost-provenance";
import {
  mapBranchLifecycleEventRows as mapBranchLifecycleEventRowsImpl,
  readBranchLifecycleEventRowsForBranch as readBranchLifecycleEventRowsForBranchImpl,
  readBranchSessionTokenRowsForBranch as readBranchSessionTokenRowsForBranchImpl,
} from "./branch-lifecycle-reads.js";
import {
  type BranchTokenAggregateRow,
  queryBranchTokenAggregateRows,
  queryBranchTokenAggregateRowsForBranch,
} from "./branch-token-aggregate-reads.js";
import type { BranchUsageEventWindowBounds } from "./branch-usage-event-window-sql.js";
import {
  readBranchAnalyticsTokenRows as readBranchAnalyticsTokenRowsImpl,
  readBranchUsageEventRows as readBranchUsageEventRowsImpl,
  readBranchUsageTokenRows as readBranchUsageTokenRowsImpl,
} from "./branch-usage-reads.js";
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
 * Active-write-link SQL predicate for the internal Wrote corpus. Publication
 * evidence is projected separately so Product membership can require both
 * signals without removing pre-publication branches from metric authority.
 * Repository-default eligibility is applied by the Branches read coordinator.
 */
export function activeWriteLinkSql(linkAlias: string, _artifactAlias: string) {
  return `${linkAlias}.method IN (${BRANCH_WRITE_METHOD_SQL})`;
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
 *   and can never be a typed delegate). These run on the one client; non-token
 *   integer columns are `Number()`-coerced at the boundary because the Prisma raw
 *   path can surface them as `bigint`. Token columns/expressions are instead
 *   `CAST(… AS TEXT)` in the SQL (see `branchTokenColumnTextSql` and siblings) so
 *   libSQL's `intMode: "number"` decode cannot throw a `RangeError` on a
 *   version-skewed counter widened past `Number.MAX_SAFE_INTEGER` before the
 *   lenient `clampStorageTokenCount` boundary can degrade it (FEA-4280).
 *
 * The serving op still issues a small bounded set of grouped reads (no per-branch
 * fan-out), mirroring the O(grouped) discipline of `aggregateSqliteUsage`.
 */

/** One `session_artifact_links` row that names a branch (branch_name non-null). */
export type BranchLinkRow = {
  repoFullName: string | null;
  branchName: string;
  /** Verified local publication retained separately from Product membership. */
  hasLocalPublication?: boolean;
  sessionId: string;
  sessionName: string | null;
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
  /**
   * The linked session's opaque owner `user_id` (multiplayer owner attribution).
   * `null` when the session carries no user identity. Resolved to a display name
   * against the cloud org directory when the branch row is projected.
   */
  ownerUserId: string | null;
};

/** One `pull_requests` row keyed to a branch (branch_name non-null). */
export type BranchPrRow = {
  repoFullName: string | null;
  branchName: string;
  prNumber: number | null;
  prUrl: string | null;
  title: string | null;
  state: string | null;
  /** Latest persisted GitHub draft observation; null when no observation exists. */
  isDraft: boolean | null;
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

/** Per-`(session, model)` token row for branch-linked sessions (usage rollup). */
export type BranchUsageTokenRow = {
  /** SQLite row identity, present only for persisted per-event rows. */
  eventRowId?: string;
  /** Numeric event identity used to reject rowid reuse across bounded reads. */
  eventFingerprint?: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  billingMode: string | null;
  createdAt: string | null;
  /** Owning session start instant, retained for legacy window consumers. */
  sessionStartedAt: string | null;
  /**
   * Captured per-row cost (`token_usage.cost_usd_estimated`) — the SAME stored
   * figure the agent dashboard sums. `null` means no captured cost. Event rows
   * carry their separately persisted per-event cost when available.
   */
  costUsdEstimated: number | null;
  /** Positive-priced evidence retained across compact aggregate transport. */
  positiveCostSignal?: true;
  /** Provider-neutral evidence carried only by event rows. */
  sourceIdentity?: TokenSourceIdentity;
  /** Provider-neutral evidence carried only by event rows. */
  costSummary?: TokenCostSummary;
  /** Present only when a persisted core token counter was clamped as invalid. */
  tokenCountsInvalid?: true;
};

/** One deterministic lifecycle boundary event for a branch detail session. */
export type BranchLifecycleEventRow = {
  repoFullName: string | null;
  branchName: string;
  sessionId: string;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
  kind: BranchLifecycleBoundaryKind;
  observedAt: string | null;
  evidenceId: string | null;
  method: string | null;
};

/** Per-session token/cost totals plus the active-write branch denominator. */
export type BranchSessionTokenRow = {
  sessionId: string;
  branchCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdEstimated: number | null;
  evenSplitCostUsd: number | null;
};

/** The selected shape both link reads (global + branch-scoped) project from. */
type BranchLinkSelectRow = {
  sessionId: string;
  isPrimary: boolean;
  observedAt: string;
  artifact: {
    repoFullName: string | null;
    branchName: string | null;
    firstPushedAt: string | null;
    artifactLinks: Array<{ id: string }>;
    linesAdded: number | null;
    linesRemoved: number | null;
    filesChanged: number | null;
  };
  session: {
    endedAt: string | null;
    name: string | null;
    startedAt: string | null;
    userId: string | null;
  };
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
    if (branchName === null) {
      return [];
    }
    return [
      {
        repoFullName: row.artifact.repoFullName,
        branchName,
        hasLocalPublication:
          row.artifact.firstPushedAt !== null ||
          row.artifact.artifactLinks.length > 0,
        sessionId: row.sessionId,
        sessionName: row.session.name,
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
        ownerUserId: row.session.userId,
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
      // Keep every active Wrote link in the internal corpus. Product-facing
      // readers apply publication eligibility after this projection; metric
      // denominator authority deliberately retains pre-publication branches.
      where: {
        method: { in: [...BRANCH_WRITE_METHOD_VALUES] },
        artifact: {
          kind: "branch",
          branchName: { not: null },
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
            firstPushedAt: true,
            artifactLinks: {
              where: { method: { in: [...BRANCH_PUSH_METHOD_VALUES] } },
              select: { id: true },
              take: 1,
            },
            linesAdded: true,
            linesRemoved: true,
            filesChanged: true,
          },
        },
        session: {
          select: {
            endedAt: true,
            name: true,
            startedAt: true,
            userId: true,
          },
        },
      },
      orderBy: [{ artifact: { branchName: "asc" } }, { observedAt: "desc" }],
    })
    .then(mapBranchLinkRows);
}

/** A distinct `(repo_full_name, branch_name)` branch key. */
export type BranchKeyRow = {
  repoFullName: string | null;
  branchName: string;
  /** Omitted by legacy/internal key constructors; Product reads fail closed. */
  hasLocalPublication?: boolean;
};

/**
 * The distinct `(repo_full_name, branch_name)` pairs — a leaner read than
 * `readLocalBranchLinkRows` when only the branch COUNT is needed (the usage
 * rollup), so it doesn't materialize every Session link row. The mapper
 * collapses duplicate Branch artifacts (NULL repo included) while OR-ing their
 * publication evidence; the caller counts via `encodeBranchId` so null-repo
 * collapsing matches the list projection byte-for-byte.
 *
 * `artifactLinks: { some: {} }` reproduces the inner JOIN against the link
 * table — a branch artifact with no Session Wrote links never appears.
 */
export function readDistinctBranchKeyRows(
  prisma: DbHostPrisma
): Promise<BranchKeyRow[]> {
  return prisma.client.artifact
    .findMany({
      // Same internal Wrote gate as `readLocalBranchLinkRows`; publication and
      // authority eligibility are resolved later.
      where: {
        kind: "branch",
        branchName: { not: null },
        artifactLinks: {
          some: { method: { in: [...BRANCH_WRITE_METHOD_VALUES] } },
        },
      },
      select: {
        repoFullName: true,
        branchName: true,
        firstPushedAt: true,
        artifactLinks: {
          where: { method: { in: [...BRANCH_PUSH_METHOD_VALUES] } },
          select: { id: true },
          take: 1,
        },
      },
    })
    .then(mapDistinctBranchKeyRows);
}

/** The raw PR-row shape both PR reads (global + branch-scoped) map. */
type BranchPrRawRow = {
  repo_full_name: string | null;
  branch_name: string;
  pr_number: number | bigint | null;
  pr_url: string | null;
  title: string | null;
  state: string | null;
  is_draft: boolean | number | null;
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
    isDraft:
      row.is_draft == null ? null : row.is_draft === true || row.is_draft === 1,
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
              pr_status.is_draft,
              pra.lines_added, pra.lines_removed, pra.files_changed
       FROM pull_requests pr
       LEFT JOIN pull_request_status_observations pr_status
         ON pr_status.repo_full_name = pr.repo_full_name
        AND pr_status.pr_number = pr.pr_number
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
      // Active-write links preserve the complete raw branch evidence set.
      `SELECT DISTINCT b.repo_full_name, b.branch_name,
              c.sha, c.committed_at, c.title AS message
       FROM session_artifact_links sal_b
       JOIN artifacts b ON b.id = sal_b.artifact_id AND b.kind = 'branch'
       JOIN session_artifact_links sal_c ON sal_c.session_id = sal_b.session_id
       JOIN artifacts c ON c.id = sal_c.artifact_id AND c.kind = 'commit'
       WHERE b.branch_name IS NOT NULL
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

/**
 * Per-`(branch, model)` token totals. A two-stage CTE deduplicates
 * session↔branch pairs first, then counts branches per session over the
 * deduplicated set — a single grouped query, no per-branch fan-out.
 *
 * ATTRIBUTION (fractional, FEA-2032 + FEA-2531): both the deduped `d` set and
 * the `branch_count` divisor keep only a session's ACTIVE WRITE links, so a
 * session linked to N
 * distinct active-write branches contributes `tokenTotal / N` to each
 * (integer-truncated via CAST(... AS INTEGER) to satisfy readStorageTokenCount's
 * integer contract). Read-only links never enter the split. These raw aggregates
 * retain every active-write branch; product eligibility is applied before the
 * aggregate is projected. Truncation is directionally conservative:
 * per-branch totals may sum to slightly less than the session total for odd
 * splits, never more.
 */
export function readBranchTokenAggregateRows(
  prisma: DbHostPrisma,
  visibleKeys?: readonly BranchKeyRow[],
  denominatorKeys: readonly BranchKeyRow[] | undefined = visibleKeys
): Promise<BranchTokenAggregateRow[]> {
  return queryBranchTokenAggregateRows(
    prisma,
    activeWriteLinkSql,
    visibleKeys,
    denominatorKeys
  );
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
      // Same internal Wrote gate as `readLocalBranchLinkRows`, scoped to one
      // branch; Product publication eligibility is resolved by the caller.
      where: {
        method: { in: [...BRANCH_WRITE_METHOD_VALUES] },
        artifact: {
          kind: "branch",
          branchName: key.branchName,
          repoFullName: key.repoFullName,
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
            firstPushedAt: true,
            artifactLinks: {
              where: { method: { in: [...BRANCH_PUSH_METHOD_VALUES] } },
              select: { id: true },
              take: 1,
            },
            linesAdded: true,
            linesRemoved: true,
            filesChanged: true,
          },
        },
        session: {
          select: {
            endedAt: true,
            name: true,
            startedAt: true,
            userId: true,
          },
        },
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
              pr_status.is_draft,
              pra.lines_added, pra.lines_removed, pra.files_changed
       FROM pull_requests pr
       LEFT JOIN pull_request_status_observations pr_status
         ON pr_status.repo_full_name = pr.repo_full_name
        AND pr_status.pr_number = pr.pr_number
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
  key: BranchKeyRow,
  visibleKeys?: readonly BranchKeyRow[],
  denominatorKeys: readonly BranchKeyRow[] | undefined = visibleKeys
): Promise<BranchTokenAggregateRow[]> {
  return queryBranchTokenAggregateRowsForBranch(
    prisma,
    key,
    activeWriteLinkSql,
    visibleKeys,
    denominatorKeys
  );
}

/**
 * FEA-2276: each session's GLOBAL active-write branch count — the SAME even-split
 * divisor `readBranchTokenAggregateRowsForBranch`'s `branch_count` subquery applies
 * to the branch total. The branch DETAIL reads only this branch's links, so it
 * cannot see how many OTHER branches a session touches; the activity rollup needs
 * that count to even-split each session's attributed segment cost consistently with
 * the total. Counts DISTINCT active-write `(session, repo, branch)` per session
 * (active Wrote links only, mirroring the aggregate's pre-publication
 * denominator). Session ids are BOUND parameters; the detail's session set is
 * small, so the `IN (…)` is well under SQLite's parameter limit.
 */
export function readSessionBranchCounts(
  prisma: DbHostPrisma,
  sessionIds: readonly string[],
  denominatorKeys?: readonly BranchKeyRow[]
): Promise<Map<string, number>> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0 || denominatorKeys?.length === 0) {
    return Promise.resolve(new Map());
  }
  const placeholders = ids.map(() => "?").join(", ");
  const eligibilityCte = denominatorKeys
    ? `WITH eligible_branches AS (
         SELECT json_extract(value, '$.repoFullName') AS repo_full_name,
                json_extract(value, '$.branchName') AS branch_name
         FROM json_each(?)
       )`
    : "";
  const eligibilitySql = denominatorKeys
    ? `AND EXISTS (
             SELECT 1 FROM eligible_branches eb
             WHERE eb.branch_name = a.branch_name
               AND eb.repo_full_name IS a.repo_full_name
           )`
    : "";
  const params = denominatorKeys
    ? [JSON.stringify(denominatorKeys), ...ids]
    : ids;
  return prisma.client
    .$queryRawUnsafe<{ session_id: string; branch_count: number | bigint }[]>(
      `${eligibilityCte}
       SELECT session_id, COUNT(*) AS branch_count FROM (
         SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
         FROM session_artifact_links sal
         JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
         WHERE a.branch_name IS NOT NULL
           AND sal.session_id IN (${placeholders})
           AND ${activeWriteLinkSql("sal", "a")}
           ${eligibilitySql}
       )
       GROUP BY session_id`,
      ...params
    )
    .then((rows) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        counts.set(row.session_id, Number(row.branch_count));
      }
      return counts;
    });
}

export type BranchLifecycleEventRawRow = {
  link_id: string | null;
  session_id: string;
  relation: string | null;
  method: string | null;
  target_kind: BranchLifecycleTargetKind;
  repo_full_name: string | null;
  branch_name: string | null;
  observed_at: string | null;
  session_started_at: string | null;
  session_ended_at: string | null;
};

type BranchLifecycleTargetKind =
  | typeof ArtifactRefTargetKind.Branch
  | typeof ArtifactRefTargetKind.Commit
  | typeof ArtifactRefTargetKind.PullRequest;

/** Lifecycle evidence for one Product Branch detail. */
export function readBranchLifecycleEventRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchKeyRow
): Promise<BranchLifecycleEventRow[]> {
  return readBranchLifecycleEventRowsForBranchImpl(
    prisma,
    key,
    activeWriteLinkSql
  );
}

/** Per-Session token totals using the pre-publication denominator authority. */
export function readBranchSessionTokenRowsForBranch(
  prisma: DbHostPrisma,
  key: BranchKeyRow,
  denominatorKeys?: readonly BranchKeyRow[]
): Promise<BranchSessionTokenRow[]> {
  return readBranchSessionTokenRowsForBranchImpl(
    prisma,
    key,
    activeWriteLinkSql,
    denominatorKeys
  );
}

// Sessions with an active-write link — shared by usage and analytics reads.
export const BRANCH_LINKED_SESSION_SUBQUERY = `
  SELECT DISTINCT sal.session_id
  FROM session_artifact_links sal
  JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
  WHERE a.branch_name IS NOT NULL
    AND ${activeWriteLinkSql("sal", "a")}`;

/** Aggregate usage rows for every active-Wrote Branch-linked Session. */
export function readBranchUsageTokenRows(
  prisma: DbHostPrisma
): Promise<BranchUsageTokenRow[]> {
  return readBranchUsageTokenRowsImpl(prisma, BRANCH_LINKED_SESSION_SUBQUERY);
}

/** Analytics token rows for every active-Wrote Branch-linked Session. */
export function readBranchAnalyticsTokenRows(
  prisma: DbHostPrisma
): Promise<BranchUsageTokenRow[]> {
  return readBranchAnalyticsTokenRowsImpl(
    prisma,
    BRANCH_LINKED_SESSION_SUBQUERY
  );
}

/** Event usage rows for every active-Wrote Branch-linked Session. */
export function readBranchUsageEventRows(
  prisma: DbHostPrisma,
  bounds?: BranchUsageEventWindowBounds
): Promise<BranchUsageTokenRow[]> {
  return readBranchUsageEventRowsImpl(
    prisma,
    BRANCH_LINKED_SESSION_SUBQUERY,
    bounds
  );
}

/** Map raw lifecycle evidence through the canonical deterministic fold. */
export function mapBranchLifecycleEventRows(
  rows: BranchLifecycleEventRawRow[]
): BranchLifecycleEventRow[] {
  return mapBranchLifecycleEventRowsImpl(rows);
}

function mapDistinctBranchKeyRows(
  rows: ReadonlyArray<{
    repoFullName: string | null;
    branchName: string | null;
    firstPushedAt: string | null;
    artifactLinks: Array<{ id: string }>;
  }>
): BranchKeyRow[] {
  const byKey = new Map<string, BranchKeyRow>();
  for (const row of rows) {
    if (row.branchName === null) {
      continue;
    }
    const id = `${row.repoFullName ?? ""}\u0000${row.branchName}`;
    const hasLocalPublication =
      row.firstPushedAt !== null || row.artifactLinks.length > 0;
    const current = byKey.get(id);
    if (
      !current ||
      (current.hasLocalPublication !== true && hasLocalPublication)
    ) {
      byKey.set(id, {
        repoFullName: row.repoFullName,
        branchName: row.branchName,
        hasLocalPublication,
      });
    }
  }
  return [...byKey.values()];
}
