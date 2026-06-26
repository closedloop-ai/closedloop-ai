import { readStorageTokenCount } from "../token-counts.js";
import type { DesktopPrisma } from "./prisma-client.js";

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
 * FEA-1791: every function takes the single `DesktopPrisma` client. The reads
 * split by whether the SQL has a clean typed-delegate form:
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
 *   and can never be a typed delegate). These run on the one client (not the
 *   separate raw `storeDb` handle); integer columns are `Number()`-coerced at the
 *   boundary because the Prisma raw path can surface them as `bigint`.
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

/**
 * Branch-naming link rows. Grouped in memory by `(repoFullName, branchName)` to
 * recover each branch's session set + most-recent `observed_at`.
 */
export function readLocalBranchLinkRows(
  prisma: DesktopPrisma
): Promise<BranchLinkRow[]> {
  // A branch is an `artifacts` row with kind='branch' (ArtifactRefTargetKind
  // .Branch); the link table joins it to the sessions that worked it. Only
  // branch artifacts define a branch, so a PR/commit artifact can't inflate the
  // list or usage. The `session` relation is the link's FK to `sessions` (a real
  // DB FK with cascade), so the nested select never drops a wanted row.
  return prisma.client.sessionArtifactLink
    .findMany({
      where: { artifact: { kind: "branch", branchName: { not: null } } },
      select: {
        sessionId: true,
        isPrimary: true,
        observedAt: true,
        // `linesAdded`/`linesRemoved`/`filesChanged` are the FEA-1899 branch
        // enrichment columns (null until enriched). They live on the one branch
        // artifact, so they repeat identically across a branch's link rows and
        // are collapsed once in the list/detail/analytics projection.
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
    .then((rows) =>
      rows.flatMap((row) => {
        const { branchName } = row.artifact;
        // Guarded by the where-filter; the flatMap-drop narrows `branchName` to
        // `string` for the BranchLinkRow contract without an unsafe cast.
        if (branchName === null) {
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
      })
    );
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
  prisma: DesktopPrisma
): Promise<BranchKeyRow[]> {
  return prisma.client.artifact
    .findMany({
      where: {
        kind: "branch",
        branchName: { not: null },
        artifactLinks: { some: {} },
      },
      select: { repoFullName: true, branchName: true },
      distinct: ["repoFullName", "branchName"],
    })
    .then((rows) =>
      rows.flatMap((row) =>
        // where-filtered to non-null; flatMap-drop narrows to `string`.
        row.branchName === null
          ? []
          : [{ repoFullName: row.repoFullName, branchName: row.branchName }]
      )
    );
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
  prisma: DesktopPrisma
): Promise<BranchPrRow[]> {
  return prisma.client
    .$queryRawUnsafe<
      {
        repo_full_name: string | null;
        branch_name: string;
        pr_number: number | null;
        pr_url: string | null;
        title: string | null;
        state: string | null;
        merged_at: string | null;
        closed_at: string | null;
        opened_at: string | null;
        observed_at: string | null;
      }[]
    >(
      `SELECT pr.repo_full_name, pr.branch_name, pr.pr_number, pr.pr_url,
              pr.title, pr.state, pr.merged_at, pr.closed_at, pr.opened_at,
              pr.observed_at
       FROM pull_requests pr
       WHERE pr.branch_name IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM session_artifact_links sal
           JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
           WHERE a.branch_name = pr.branch_name
             AND a.repo_full_name IS NOT DISTINCT FROM pr.repo_full_name
         )
       ORDER BY pr.branch_name ASC, pr.observed_at DESC NULLS LAST,
                pr.pr_number DESC NULLS LAST`
    )
    .then((rows) =>
      rows.map((row) => ({
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
      }))
    );
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
  prisma: DesktopPrisma
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
      `SELECT DISTINCT b.repo_full_name, b.branch_name,
              c.sha, c.committed_at, c.title AS message
       FROM session_artifact_links sal_b
       JOIN artifacts b ON b.id = sal_b.artifact_id AND b.kind = 'branch'
       JOIN session_artifact_links sal_c ON sal_c.session_id = sal_b.session_id
       JOIN artifacts c ON c.id = sal_c.artifact_id AND c.kind = 'commit'
       WHERE b.branch_name IS NOT NULL
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
 * ATTRIBUTION (fractional, FEA-2032): a session linked to N distinct branches
 * contributes `tokenTotal / N` to each branch (integer-truncated via
 * CAST(... AS INTEGER) to satisfy readStorageTokenCount's integer contract).
 * Truncation is directionally conservative: per-branch totals may sum to
 * slightly less than the session total for odd splits, never more.
 */
export function readBranchTokenAggregateRows(
  prisma: DesktopPrisma
): Promise<BranchTokenAggregateRow[]> {
  return prisma.client
    .$queryRawUnsafe<
      {
        repo_full_name: string | null;
        branch_name: string;
        model: string;
        input_tokens: string | null;
        output_tokens: string | null;
        cache_read_tokens: string | null;
        cache_write_tokens: string | null;
        cost_usd_estimated: number | null;
      }[]
    >(
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
                )) AS branch_count
         FROM (
           SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
           FROM session_artifact_links sal
           JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
           WHERE a.branch_name IS NOT NULL
         ) d
       ) l ON l.session_id = t.session_id
       GROUP BY l.repo_full_name, l.branch_name, t.model
       ORDER BY l.branch_name ASC, t.model ASC`
    )
    .then((rows) =>
      rows.map((row) => ({
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
          row.cost_usd_estimated == null
            ? null
            : Number(row.cost_usd_estimated),
      }))
    );
}

/**
 * Read + map the `token_usage` rows for a KNOWN branch-linked session-id set —
 * the shared tail of both usage-token reads. `token_usage` has no Prisma relation
 * to `sessions`, so cost/token columns come from the typed delegate keyed by
 * `sessionId IN (…)` and `billingMode` is joined back in JS from
 * `billingBySession` (empty map → `null`, for callers that don't need the split).
 * token columns are NOT NULL DEFAULT 0 and arrive as `bigint`, which `tokenCount`
 * coerces to a safe JS number.
 */
async function readTokenUsageRowsForSessions(
  prisma: DesktopPrisma,
  sessionIds: string[],
  billingBySession: ReadonlyMap<string, string | null>
): Promise<BranchUsageTokenRow[]> {
  if (sessionIds.length === 0) {
    return [];
  }
  const tokenRows = await prisma.client.tokenUsage.findMany({
    where: { sessionId: { in: sessionIds } },
    select: {
      sessionId: true,
      model: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      createdAt: true,
      costUsdEstimated: true,
    },
    orderBy: [{ sessionId: "asc" }, { model: "asc" }],
  });
  return tokenRows.map((row) => ({
    sessionId: row.sessionId,
    model: row.model,
    inputTokens: tokenCount(row.inputTokens, "branch_usage.input_tokens"),
    outputTokens: tokenCount(row.outputTokens, "branch_usage.output_tokens"),
    cacheReadTokens: tokenCount(
      row.cacheReadTokens,
      "branch_usage.cache_read_tokens"
    ),
    cacheWriteTokens: tokenCount(
      row.cacheWriteTokens,
      "branch_usage.cache_write_tokens"
    ),
    billingMode: billingBySession.get(row.sessionId) ?? null,
    createdAt: row.createdAt,
    costUsdEstimated: row.costUsdEstimated ?? null,
  }));
}

/**
 * One token row per `(session, model)` for every session linked to a branch,
 * counted once (the link read dedupes sessions touching multiple branches) so
 * usage totals never double-count. `token_usage`'s PK is `(session_id, model)`,
 * so `created_at` is single per group and usable as the hour-bucket timestamp.
 *
 * `token_usage` has no Prisma relation to `sessions` (no DB FK to model — see the
 * schema note), so this splits into two reads: (1) the branch-linked sessions +
 * their `billing_mode`, read through the link table's REAL `session` relation and
 * deduped to one row per session; (2) those sessions' token rows (the shared
 * `readTokenUsageRowsForSessions` tail). A caller that ALREADY holds the session
 * ids (analytics, from `readLocalBranchLinkRows`) skips read (1) via
 * `readBranchUsageTokenRowsForSessions`.
 */
export async function readBranchUsageTokenRows(
  prisma: DesktopPrisma
): Promise<BranchUsageTokenRow[]> {
  const sessionRows = await prisma.client.sessionArtifactLink.findMany({
    where: { artifact: { kind: "branch", branchName: { not: null } } },
    select: { sessionId: true, session: { select: { billingMode: true } } },
    distinct: ["sessionId"],
  });
  const billingBySession = new Map(
    sessionRows.map((row) => [row.sessionId, row.session.billingMode])
  );
  return readTokenUsageRowsForSessions(
    prisma,
    sessionRows.map((row) => row.sessionId),
    billingBySession
  );
}

/**
 * Same per-`(session, model)` token rows as `readBranchUsageTokenRows`, but for a
 * session-id set the CALLER already collected (e.g. analytics, from
 * `readLocalBranchLinkRows`). Skipping the internal `session_artifact_links`
 * re-query collapses the analytics read path from 4 DB round-trips to 3. Ids are
 * deduped defensively. Billing mode is NOT resolved — the rows carry
 * `billingMode: null`; callers that need the subscription/API split (the usage
 * summary) must use `readBranchUsageTokenRows`.
 */
export function readBranchUsageTokenRowsForSessions(
  prisma: DesktopPrisma,
  sessionIds: string[]
): Promise<BranchUsageTokenRow[]> {
  return readTokenUsageRowsForSessions(
    prisma,
    [...new Set(sessionIds)],
    new Map()
  );
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
  prisma: DesktopPrisma
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
       WHERE te.session_id IN (
         SELECT DISTINCT sal.session_id
         FROM session_artifact_links sal
         JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
         WHERE a.branch_name IS NOT NULL
       )
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
