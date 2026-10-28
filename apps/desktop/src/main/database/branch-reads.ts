import type { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import type { Priority } from "@repo/api/src/types/common";
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
  jsonIdListInSql,
  sqlStringList,
} from "./db-constants.js";
import type { DbHostPrisma } from "./prisma-client.js";
import {
  allOrNothingCanonicalSortSql,
  canonicalRankingKeySql,
} from "./session-timestamp-form.js";

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
 * ISS-10324 (review): latest push occurrence per branch artifact, aggregated
 * ONCE over the push links and joined, NOT re-derived per outer row. As a
 * correlated subquery this re-scanned a branch's whole link set for every
 * session that wrote it, which is quadratic on a long-lived branch and had only
 * `idx_sal_artifact` to lean on.
 *
 * Ranked by the canonical INSTANT, never by stored bytes: `observed_at` is TEXT,
 * so a byte-wise `MAX` returns the EARLIER instant whenever a group mixes
 * `…:00Z` with `…:00.500Z` (`Z` is 0x5A, `.` is 0x2E). The all-or-nothing fold
 * partitions by `artifact_id` because the answer is a value from WITHIN each
 * artifact's own group — it is never a ranking BETWEEN artifacts, which is the
 * mode-mixing shape that fold must not be used for.
 *
 * The projected value stays the RAW stored `observed_at` of the winning row, so
 * this read surfaces exactly what the retired nested `orderBy … take 1` did.
 * That relies on SQLite's documented bare-column rule: in a grouped query whose
 * only aggregate is a single `MAX`/`MIN`, the non-aggregated columns come from
 * the row that produced it.
 */
const LATEST_PUSH_PER_ARTIFACT_SQL = `(
        SELECT
          ranked.artifact_id AS artifact_id,
          ranked.observed_at AS latest_push_observed_at,
          MAX(push_canonical_sort)
        FROM (
          SELECT
            sal_push.artifact_id AS artifact_id,
            sal_push.observed_at AS observed_at,
            ${allOrNothingCanonicalSortSql(
              canonicalRankingKeySql("sal_push.observed_at"),
              "sal_push.observed_at",
              "PARTITION BY sal_push.artifact_id"
            )} AS push_canonical_sort
          FROM session_artifact_links sal_push
          WHERE sal_push.method IN (${BRANCH_PUSH_METHOD_SQL})
        ) ranked
        GROUP BY ranked.artifact_id
      )`;

/** Branch artifacts carrying at least one push link, aggregated once. */
const PUSHED_ARTIFACT_IDS_SQL = `(
        SELECT DISTINCT sal_push.artifact_id AS artifact_id
          FROM session_artifact_links sal_push
         WHERE sal_push.method IN (${BRANCH_PUSH_METHOD_SQL})
      )`;

/**
 * Active-write-link SQL predicate for the internal Wrote corpus. Publication
 * evidence is projected separately; the eligibility coordinator requires it
 * for Product membership AND the metric divisor (ISS-8148, PRD-683 D7) — the
 * raw corpus itself retains every Wrote link.
 * Repository-default eligibility is applied by the Branches read coordinator.
 */
export function activeWriteLinkSql(linkAlias: string, _artifactAlias: string) {
  return `${linkAlias}.method IN (${BRANCH_WRITE_METHOD_SQL})`;
}

/**
 * Local SQLite read layer for the Branches serving ops (FEA-1948 / Epic B B1).
 *
 * Since FEA-1899 a "branch" is a row in the `artifacts` table (`kind='branch'`,
 * carrying `repo_full_name`/`branch_name`);
 * `session_artifact_links` became a pure join (`session_id` ↔ `artifact_id`). So
 * these reads JOIN `artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'`
 * to recover the sessions that worked each branch. PR metadata still comes from
 * `pull_requests`; token cost from `token_usage` joined back through the link
 * table. The GitHub-only columns (LOC, PR state, base ref, checks, review
 * decision, ahead/behind) have no local store and stay `null`.
 *
 * Every function takes the read-only `DbHostPrisma` client (prisma.client). The reads split by
 * whether the SQL has a clean typed-delegate form:
 *
 * - TYPED delegates (preferred — `prisma.client.<model>.findMany`):
 *   `readLocalBranchLinkRowsForBranch` (the branch-SCOPED link read, whose
 *   nested selects are bounded by one branch), and `readBranchUsageTokenRows`
 *   (two keyed reads — branch-linked sessions via
 *   the link table's `session` relation, then their `token_usage` rows by
 *   `sessionId IN (…)` — joined in JS, since `token_usage` has no session
 *   relation to model without drifting the migration). Typed Int columns come
 *   back as JS `number`/`bigint` directly, so no per-row coercion is needed
 *   beyond the existing `tokenCount` (bigint → number) boundary.
 *
 * - RAW reads on the read-only `prisma.client.$queryRawUnsafe` escape hatch,
 *   each because it has no clean typed form (NOT as a shortcut):
 *   `readLocalBranchLinkRows` and `readDistinctBranchKeyRows` (BOTH raw since
 *   ISS-10324 — a nested select binds one host parameter per parent row, so the
 *   typed form's bind count scaled with the corpus and overflowed SQLite's
 *   `SQLITE_MAX_VARIABLE_NUMBER`; a JOIN binds nothing per row),
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
  /** Latest trustworthy successful-push occurrence, when persisted locally. */
  successfulPushAt?: string | null;
  sessionId: string;
  sessionName: string | null;
  /** ISS-11915: Sessions window timestamp, excluding link/import observation. */
  sessionLastActivityAt?: string | null;
  isPrimary: boolean;
  /** When the link was *observed/scanned* (wall-clock import time). */
  observedAt: string;
  /** Legacy turn-time projection; never the ISS-11915 window fallback. */
  activityAt: string;
  /** Always `null`: the local store holds no branch LOC. */
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
  /**
   * The linked session's opaque owner `user_id` (multiplayer owner attribution).
   * `null` when the session carries no user identity. Resolved to a display name
   * against the cloud org directory when the branch row is projected.
   */
  ownerUserId: string | null;
  /** ISS-10332: the joined branch artifact's priority; `null` is none. */
  priority: Priority | null;
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
  /** Always `null`: the local store holds no PR LOC. */
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
    artifactLinks: Array<{ id: string; observedAt: string }>;
    priority: Priority | null;
  };
  session: {
    lastActivityAt: string | null;
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
        successfulPushAt:
          row.artifact.artifactLinks[0]?.observedAt ??
          row.artifact.firstPushedAt,
        sessionId: row.sessionId,
        sessionName: row.session.name,
        sessionLastActivityAt: row.session.lastActivityAt,
        isPrimary: row.isPrimary,
        observedAt: row.observedAt,
        linesAdded: null,
        linesRemoved: null,
        filesChanged: null,
        activityAt:
          row.session.endedAt ?? row.session.startedAt ?? row.observedAt,
        ownerUserId: row.session.userId,
        priority: row.artifact.priority,
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
  // RAW, not the typed delegate (ISS-10324). A `findMany` selecting nested
  // relations resolves each one with a SECOND statement that binds one host
  // parameter per parent row, so the bind count scaled with the corpus: this
  // read crossed SQLite's SQLITE_MAX_VARIABLE_NUMBER floor (999 on older
  // builds) and threw, and `getSharedBranchesPageData` treats it as fatal, so
  // the whole Branches screen lost its data. BOTH nested selects overflowed --
  // the to-many `artifact.artifactLinks` on a profile wide in branches, and the
  // to-one `session` on one wide in sessions -- so chunking either alone leaves
  // the other live. JOINs bind nothing per row, and the method lists are
  // inlined as literals by `sqlStringList`, so this statement's parameter count
  // is a constant zero at any corpus size.
  //
  // The joined `latest_push_observed_at` reproduces the nested `orderBy
  // observed_at desc, take 1` (see `LATEST_PUSH_PER_ARTIFACT_SQL`): the column
  // is NOT NULL, so the LEFT JOIN misses — and the value is null — exactly when
  // the branch has no push link, the same signal the empty array carried.
  // Rows are mapped
  // back into the select shape so `mapBranchLinkRows` stays the ONE place the
  // COALESCE and publication derivations live, per its own contract.
  return prisma.client
    .$queryRawUnsafe<BranchLinkRawRow[]>(
      `SELECT
         sal.session_id   AS session_id,
         sal.is_primary   AS is_primary,
         sal.observed_at  AS observed_at,
         a.repo_full_name AS repo_full_name,
         a.branch_name    AS branch_name,
         a.first_pushed_at AS first_pushed_at,
         a.priority       AS priority,
         s.last_activity_at AS last_activity_at,
         s.ended_at       AS ended_at,
         s.name           AS session_name,
         s.started_at     AS started_at,
         s.user_id        AS user_id,
         push.latest_push_observed_at AS latest_push_observed_at
       FROM session_artifact_links sal
       JOIN artifacts a
         ON a.id = sal.artifact_id
        AND a.kind = 'branch'
       JOIN sessions s
         ON s.id = sal.session_id
       LEFT JOIN ${LATEST_PUSH_PER_ARTIFACT_SQL} push
         ON push.artifact_id = a.id
       WHERE ${activeWriteLinkSql("sal", "a")}
         AND a.branch_name IS NOT NULL
       ORDER BY a.branch_name ASC, sal.observed_at DESC`
    )
    .then((rows) => mapBranchLinkRows(rows.map(toBranchLinkSelectRow)));
}

/** Flat row shape of the `readLocalBranchLinkRows` raw statement. */
type BranchLinkRawRow = {
  session_id: string;
  is_primary: number | boolean;
  observed_at: string;
  repo_full_name: string | null;
  branch_name: string | null;
  first_pushed_at: string | null;
  priority: Priority | null;
  last_activity_at: string | null;
  ended_at: string | null;
  session_name: string | null;
  started_at: string | null;
  user_id: string | null;
  latest_push_observed_at: string | null;
};

/**
 * Re-shape one raw row into the delegate's select shape so the derivations stay
 * in `mapBranchLinkRows`. The synthesized `artifactLinks` entry carries only the
 * two fields that mapper reads.
 */
function toBranchLinkSelectRow(row: BranchLinkRawRow): BranchLinkSelectRow {
  return {
    sessionId: row.session_id,
    // SQLite stores the Boolean column as 0/1, which raw reads return as-is.
    isPrimary: Boolean(row.is_primary),
    observedAt: row.observed_at,
    artifact: {
      repoFullName: row.repo_full_name,
      branchName: row.branch_name,
      firstPushedAt: row.first_pushed_at,
      artifactLinks:
        row.latest_push_observed_at === null
          ? []
          : [{ id: "", observedAt: row.latest_push_observed_at }],
      priority: row.priority,
    },
    session: {
      lastActivityAt: row.last_activity_at,
      endedAt: row.ended_at,
      name: row.session_name,
      startedAt: row.started_at,
      userId: row.user_id,
    },
  };
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
 * The inner JOIN against the link table reproduces `artifactLinks: { some: {} }`
 * — a branch artifact with no Session Wrote links never appears.
 */
export function readDistinctBranchKeyRows(
  prisma: DbHostPrisma
): Promise<BranchKeyRow[]> {
  // RAW, not the typed delegate (ISS-10324 review). The retired `findMany`
  // selected the nested to-many `artifactLinks` for its push evidence, which
  // Prisma resolves with a SECOND statement binding one host parameter per
  // parent artifact row — the same overflow `readLocalBranchLinkRows` hit, on
  // the same serving path (`getSharedBranchesPageData` reads this for the
  // branch count), so fixing only that one left the page dying at the same
  // corpus width. JOINs bind nothing per row and the method lists are inlined
  // as literals, so this statement's parameter count is a constant zero.
  return prisma.client
    .$queryRawUnsafe<BranchKeyRawRow[]>(
      `SELECT DISTINCT
         a.repo_full_name  AS repo_full_name,
         a.branch_name     AS branch_name,
         a.first_pushed_at AS first_pushed_at,
         CASE WHEN push.artifact_id IS NULL THEN 0 ELSE 1 END AS has_push_link
       FROM artifacts a
       JOIN session_artifact_links sal
         ON sal.artifact_id = a.id
        AND ${activeWriteLinkSql("sal", "a")}
       LEFT JOIN ${PUSHED_ARTIFACT_IDS_SQL} push
         ON push.artifact_id = a.id
       WHERE a.kind = 'branch'
         AND a.branch_name IS NOT NULL`
    )
    .then((rows) => mapDistinctBranchKeyRows(rows.map(toBranchKeySelectRow)));
}

/** Flat row shape of the `readDistinctBranchKeyRows` raw statement. */
type BranchKeyRawRow = {
  repo_full_name: string | null;
  branch_name: string | null;
  first_pushed_at: string | null;
  has_push_link: number | bigint | boolean;
};

/**
 * Re-shape one raw key row into the delegate's select shape so the publication
 * derivation stays in `mapDistinctBranchKeyRows`. The synthesized
 * `artifactLinks` entry carries only the presence that mapper reads.
 */
function toBranchKeySelectRow(row: BranchKeyRawRow): {
  repoFullName: string | null;
  branchName: string | null;
  firstPushedAt: string | null;
  artifactLinks: Array<{ id: string }>;
} {
  return {
    repoFullName: row.repo_full_name,
    branchName: row.branch_name,
    firstPushedAt: row.first_pushed_at,
    // SQLite returns the CASE as 0/1; some libSQL builds widen it to bigint.
    artifactLinks: Number(row.has_push_link) === 0 ? [] : [{ id: "" }],
  };
}

/** The raw PR-row shape both PR reads (global + branch-scoped) map. */
type BranchPrRawRow = {
  repo_full_name: string | null;
  branch_name: string;
  pr_number: number | bigint | null;
  pr_url: string | null;
  closed_at: string | null;
  opened_at: string | null;
  observed_at: string | null;
};

/**
 * Shared mapper so the global `readLocalBranchPrRows` and the branch-scoped
 * `readLocalBranchPrRowsForBranch` cannot drift. Title, state, draft, merge time
 * and LOC have no local store and map to `null`.
 */
function mapBranchPrRawRows(rows: BranchPrRawRow[]): BranchPrRow[] {
  return rows.map((row) => ({
    repoFullName: row.repo_full_name,
    branchName: row.branch_name,
    // Number()-coerce: the Prisma raw path can return INTEGER as bigint.
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
    prUrl: row.pr_url,
    title: null,
    state: null,
    isDraft: null,
    mergedAt: null,
    closedAt: row.closed_at,
    openedAt: row.opened_at,
    observedAt: row.observed_at,
    linesAdded: null,
    linesRemoved: null,
    filesChanged: null,
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
      `SELECT pr.repo_full_name, pr.branch_name, pr.pr_number, pr.pr_url,
              pr.closed_at, pr.opened_at, pr.observed_at
       FROM pull_requests pr
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
              select: { id: true, observedAt: true },
              orderBy: { observedAt: "desc" },
              take: 1,
            },
            priority: true,
          },
        },
        session: {
          select: {
            lastActivityAt: true,
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
 * otherwise), so a `(repo, branch)`-keyed read is exact AND cheaper.
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
              pr.closed_at, pr.opened_at, pr.observed_at
       FROM pull_requests pr
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
 *
 * ISS-10365: the session set is passed through `jsonIdListInSql` as ONE bound
 * JSON array, not one host parameter per session. The typed delegate this
 * replaced bound `sessionId: { in: [...] }` one-per-id, so a branch written by
 * more than ~999 sessions threw `SQLITE_MAX_VARIABLE_NUMBER` and the detail page
 * would not open. Every session that wrote the branch is still read — the list
 * is folded into the statement rather than capped or chunked.
 */
export function readBranchCommitRowsForSessions(
  prisma: DbHostPrisma,
  sessionIds: readonly string[],
  key: BranchKeyRow
): Promise<BranchCommitRow[]> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) {
    return Promise.resolve([]);
  }
  return prisma.client
    .$queryRawUnsafe<
      { sha: string; committed_at: string; message: string | null }[]
    >(
      `SELECT DISTINCT c.sha, c.committed_at, c.title AS message
       FROM session_artifact_links sal
       JOIN artifacts c ON c.id = sal.artifact_id AND c.kind = 'commit'
       WHERE ${jsonIdListInSql("sal.session_id")}
         AND c.sha IS NOT NULL
         AND c.committed_at IS NOT NULL
       ORDER BY c.committed_at ASC`,
      JSON.stringify(ids)
    )
    .then((rows) => {
      const bySha = new Map<string, BranchCommitRow>();
      for (const row of rows) {
        // Collapse a commit reached via more than one of the branch's sessions;
        // the statement already orders by instant, so the surviving row for a
        // sha is its earliest and the map's insertion order IS the rail order.
        if (bySha.has(row.sha)) {
          continue;
        }
        bySha.set(row.sha, {
          repoFullName: key.repoFullName,
          branchName: key.branchName,
          sha: row.sha,
          committedAt: row.committed_at,
          message: row.message,
        });
      }
      return [...bySha.values()];
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
 * (active Wrote links only, restricted by the caller's publication-gated
 * `denominatorKeys` — ISS-8148).
 *
 * ISS-10365: the session ids bind as ONE JSON array via `jsonIdListInSql`, not
 * one host parameter each. This read takes the SAME `sessionIds` list as
 * `readBranchCommitRowsForSessions` from the same `getSharedBranchDetail` call,
 * so a `?`-per-id `IN (…)` here overflowed `SQLITE_MAX_VARIABLE_NUMBER` at the
 * same corpus width and left the detail page dead after the commit read was
 * fixed.
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
  const idListJson = JSON.stringify(ids);
  const params = denominatorKeys
    ? [JSON.stringify(denominatorKeys), idListJson]
    : [idListJson];
  return prisma.client
    .$queryRawUnsafe<{ session_id: string; branch_count: number | bigint }[]>(
      `${eligibilityCte}
       SELECT session_id, COUNT(*) AS branch_count FROM (
         SELECT DISTINCT sal.session_id, a.repo_full_name, a.branch_name
         FROM session_artifact_links sal
         JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
         WHERE a.branch_name IS NOT NULL
           AND ${jsonIdListInSql("sal.session_id")}
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

/** Per-Session token totals using the publication-gated denominator authority. */
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
