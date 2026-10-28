import {
  costBucketRawBounds,
  costFilterIncludesUnknown,
  getSessionCostBucket,
  isExhaustiveCostFilter,
  resolveSessionQuality,
  SessionChangePresenceId,
  SessionPrAssociationId,
} from "@repo/api/src/agent-session-filters";
import { autonomyTierRange } from "@repo/api/src/session-autonomy-tiers";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { SUBSCRIPTION_BILLING_MODES } from "@repo/api/src/types/billing-mode";
import { RETIRED_DISPLAY_FACET_SPELLINGS } from "@repo/api/src/types/session-status";
import { Prisma, withDb } from "@repo/database";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";
import { escapeSqlLikeLiteral } from "@/lib/sql-like";
import { buildComponentSessionScope } from "../../agent-components/service/component-session-scope";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "../validators";
import { isUuid } from "./coercion";
import { buildPriorityFacetWhere } from "./priority-facet-where";
import { buildProjectLinkWhere } from "./project-link-where";
import {
  type AgentSessionScope,
  type SourceArtifactSummaryRecord,
  sourceArtifactSummarySelect,
} from "./records";
import { buildDbSortOrderBy } from "./session-sort-order";
import { SESSION_SUBSTANTIVE_WHERE } from "./session-substantive-predicate";

export const ANALYTICS_QUERY_BATCH_SIZE = 200;

// "Has changes" is defined against every LOC signal the Sessions row renders:
// the scalar `+linesAdded / -linesRemoved` / files-changed columns (which back
// both the top-level counts and the git diff-stat projection) AND the dedicated
// branch_* columns (branchDiffStats), which round-trip independently. This keeps
// the cloud filter in step with the desktop matcher (`localSessionHasChanges`,
// which folds top-level LOC + git + branch diff stats) and the rendered row. A
// session has changes when any count is greater than zero.
const SESSION_HAS_CHANGES_WHERE: Prisma.SessionDetailWhereInput = {
  OR: [
    { filesChanged: { gt: 0 } },
    { linesAdded: { gt: 0 } },
    { linesRemoved: { gt: 0 } },
    { branchFilesChanged: { gt: 0 } },
    { branchLinesAdded: { gt: 0 } },
    { branchLinesRemoved: { gt: 0 } },
  ],
};

// "No changes" is the null-safe complement: every diff count (scalar and
// branch_*) is null or <= 0. Expressed positively rather than as a structural
// Prisma `NOT` over the OR, because the LOC columns are nullable Int (`Int?`): a
// `NOT ((a>0) OR (b>0) OR …)` evaluates to SQL NULL for an all-null row
// (three-valued logic) and silently drops it, whereas `sessionHasChanges`
// coalesces null to 0 and calls such a session "no changes". Coalescing here
// (null OR <= 0 per column) keeps the cloud query in step with the SSOT
// predicate and the desktop matcher.
const SESSION_NO_CHANGES_WHERE: Prisma.SessionDetailWhereInput = {
  AND: [
    { OR: [{ filesChanged: null }, { filesChanged: { lte: 0 } }] },
    { OR: [{ linesAdded: null }, { linesAdded: { lte: 0 } }] },
    { OR: [{ linesRemoved: null }, { linesRemoved: { lte: 0 } }] },
    { OR: [{ branchFilesChanged: null }, { branchFilesChanged: { lte: 0 } }] },
    { OR: [{ branchLinesAdded: null }, { branchLinesAdded: { lte: 0 } }] },
    { OR: [{ branchLinesRemoved: null }, { branchLinesRemoved: { lte: 0 } }] },
  ],
};

// A session is associated with a pull request when either PR source carries one:
// the legacy `pullRequests` JSON (desktop-reported, written as a non-empty array
// or DbNull — see toNullableJsonPatch) OR the canonical session→PR artifact link
// (a RelatesTo source link tagged linkKind === "session_pr"). This matches the
// two sources `toSessionPullRequestProjection` merges into `prs`. It is a
// SUPERSET of the PR pills the row shows: two read-boundary suppressions cannot
// be expressed in SQL, so a matched row can legitimately render with zero pills
// (and, filtered to has-PR, read "Pull requests: None").
//   1. FEA-4188: a row whose PR resolves no head branch has its PR SUPPRESSED by
//      `enforcePrBranchInvariant` (projections.ts). Branch resolution walks the
//      session→branch links, not a column.
//   2. ISS-4768: a row whose blob PRs were all adjudicated non-authoring by
//      `toSessionPullRequestProjection` (a Referenced/Reviewed link, or a PR
//      inherited from a branch the session only checked out) has them dropped.
//      Authorship lives in each source link's derived purpose, not a column.
// Both are display-side corrections of an attribution the raw columns overstate;
// this filter intentionally still matches those rows rather than under-returning,
// which is the same trade-off the orphan case has always carried. The has-PR
// facet count inherits the same caveat: it counts associated rows, not pills.
export const SESSION_HAS_PR_WHERE: Prisma.SessionDetailWhereInput = {
  OR: [
    {
      AND: [
        { pullRequests: { not: Prisma.DbNull } },
        { pullRequests: { not: [] } },
      ],
    },
    {
      artifact: {
        is: {
          sourceLinks: {
            some: {
              linkType: LinkType.RelatesTo,
              // ISS-5823 Metric: this facet renders a COUNT and filters the
              // list. A prose mention is not the session having a PR.
              ...sessionPrLinkKindWhere(SessionPrLinkAudience.Metric),
            },
          },
        },
      },
    },
  ],
};

// The null-safe complement of SESSION_SUBSTANTIVE_WHERE: an idle session has no
// turn (null or <= 0) AND zero of every token AND no tool use AND no component
// invocation (ISS-5801). Expressed
// positively (rather than a structural `NOT` over the OR) because `turns` is a
// nullable Int — a `NOT ((turns>0) OR …)` evaluates to SQL NULL for a null-turns
// row (three-valued logic) and would silently drop it, whereas coalescing null
// to 0 here classifies such a row as idle. Used to count idle rows within the
// current filter scope (the reveal label) — see `findSessions`.
export const SESSION_IDLE_WHERE: Prisma.SessionDetailWhereInput = {
  AND: [
    { OR: [{ turns: null }, { turns: { lte: 0 } }] },
    { inputTokens: { lte: 0 } },
    { outputTokens: { lte: 0 } },
    { cacheReadTokens: { lte: 0 } },
    { cacheWriteTokens: { lte: 0 } },
    { toolUseCount: { lte: 0 } },
    { componentInvocationCount: { lte: 0 } },
  ],
};

// PLN-1034: the Sessions list default order and the per-column order-by now live
// in the single source of truth `session-sort-order.ts`, which owns the
// FEA-4329 unique tiebreaker and FEA-4330 nulls-last invariants; `buildAgentSessionOrderBy`
// below re-exports the DB-native builder for the existing call sites.

// ISS-12645 resolves component identity before every population-dependent read.
export async function buildWhere(
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery | AgentSessionListQuery,
  // Which timestamp the date window filters on. Analytics keeps the
  // `sessionStartedAt` default (a session belongs to the period it started in).
  // The Sessions list, the usage summary, AND the CSV export opt into
  // `lastActivityAt` ("active in this window") so the window matches the field
  // the list is ordered by and all three surfaces paint one cohort — see the
  // `lastActivityAt` branch below (FEA-2180/FEA-4298/FEA-4326). The export
  // reaches this field via `buildUsageSummaryWhere`, not directly.
  dateField: "sessionStartedAt" | "lastActivityAt" = "sessionStartedAt"
): Promise<Prisma.SessionDetailWhereInput> {
  // Hoisted fields (organizationId, projectId, status, and other plain-equality
  // facets) are filtered through the parent `artifact` relation; session-specific
  // fields (harness, sessionStartedAt) stay on the detail row. ISS-9939 /
  // ISS-10629 moved Status into this hoisted set — it no longer references any
  // SessionDetail field, so it no longer needs the session-level treatment its
  // Waiting/Active/Stale predicate used to require.
  const artifactWhere: Prisma.ArtifactWhereInput = {
    organizationId: scope.organizationId,
  };
  const where: Prisma.SessionDetailWhereInput = {
    artifact: { is: artifactWhere },
  };

  if (isMissingTeamScope(filters)) {
    where.artifactId = { in: [] };
    return Promise.resolve(where);
  }

  applySessionFacetFilters(where, filters);
  applySearchFilter(where, filters);
  applyArtifactFacetFilters(artifactWhere, filters);
  applyQualityFilter(where, filters);
  applyDateFilter(where, filters, dateField);
  applyCompletionFilter(where, filters);
  applyViewerScope(artifactWhere, scope, filters);

  if (filters.componentSlug) {
    return {
      AND: [
        where,
        await buildComponentSessionScope(
          scope.organizationId,
          filters.componentSlug
        ),
      ],
    };
  }
  return where;
}

/**
 * FEA-3534: enforce `viewerScope=self` server-side. Historically the "Me" scope
 * on the dashboard / personal Sessions page was only a client courtesy — the
 * request passed a `userId` filter (or, in the Recent Sessions card, nothing at
 * all), and the server never pinned the result to the authenticated user, so a
 * dropped/forged param silently widened the read to the whole org. Self scope
 * now pins the read to the authenticated viewer's own id, so a self read can
 * never return another user's sessions. A self request without a resolved
 * `viewerId` fails closed to an impossible predicate rather than leaking
 * org-wide rows.
 *
 * ISS-12251: of the client-sent person filters, self scope replaces only the
 * singular `userId` deep link ({@link applyArtifactPersonFilters} skips it under
 * self scope). The Owner facet `userIds` still applies as its own conjunct on
 * the assignee, so a self read filtered by Owner is "my sessions that X owns".
 * Self scope itself pins Created by (`artifacts.created_by_id`, PLN-2176 D-4),
 * the column the typed-SQL statements match `creatorUserIds` against.
 */
function applyViewerScope(
  artifactWhere: Prisma.ArtifactWhereInput,
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  if (filters.viewerScope !== AgentSessionViewerScope.Self) {
    return;
  }
  artifactWhere.createdById = scope.viewerId ?? { in: [] };
}

/**
 * FEA-3284/FEA-3345/FEA-4145: narrow the result set by the `quality` segment.
 * `substantive` ANDs the substantive predicate (hides idle rows); `idle` ANDs
 * the null-safe idle complement (shows ONLY idle rows); `all` (also the fail-open
 * default for an absent `quality`) applies nothing so every session shows —
 * matching pre-FEA-3284 behavior for ungated callers (dashboards, insights,
 * feeds, telemetry, CSV export). Whichever clause is ANDed keeps the list and
 * every aggregation that reuses `buildWhere` (usage/summary, analytics, export)
 * mutually consistent, since they all resolve the default through this one seam
 * (AGENTS.md aggregation rule).
 */
function applyQualityFilter(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  const effectiveQuality = resolveSessionQuality(filters.quality);
  if (effectiveQuality === "substantive") {
    appendAndClauses(where, [SESSION_SUBSTANTIVE_WHERE]);
    return;
  }
  if (effectiveQuality === "idle") {
    appendAndClauses(where, [SESSION_IDLE_WHERE]);
    return;
  }
}

/**
 * Count the sessions that match ALL of the current filters (facets + date
 * window) EXCEPT the quality filter, and are idle — the accurate "N idle
 * sessions hidden" reveal label. Built by taking the substantive-forced where
 * and swapping the substantive clause for its idle complement, so the two counts
 * (visible substantive rows + hidden idle rows) partition the same filtered set.
 */
export async function buildIdleCountWhere(
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery | AgentSessionListQuery,
  dateField: "sessionStartedAt" | "lastActivityAt" = "sessionStartedAt"
): Promise<Prisma.SessionDetailWhereInput> {
  // Reuse buildWhere with quality forced OFF (so it carries every OTHER filter
  // but not the substantive clause), then AND the idle complement.
  const where = await buildWhere(
    scope,
    { ...filters, quality: "all" },
    dateField
  );
  appendAndClauses(where, [SESSION_IDLE_WHERE]);
  return where;
}

/**
 * ISS-8554 Phase 3: exported so the list-sort SQL reader can mirror this
 * early-return before issuing a query, since the SQL statement's facet
 * predicates have no spelling for "team scope requested with no team id" —
 * `buildWhere` answers it with an impossible `artifactId` predicate instead of
 * a WHERE clause this reader could reuse.
 */
export function isMissingTeamScope(
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): boolean {
  return (
    filters.viewerScope === AgentSessionViewerScope.Team &&
    filters.teamId === undefined
  );
}

/**
 * Append AND-clauses to a where-predicate, normalizing the existing `where.AND`
 * (which Prisma allows to be either a single object or an array) to an array
 * first. Shared by the session-facet and status-facet builders so they merge
 * their clauses identically.
 */
function appendAndClauses<Where extends { AND?: Where | Where[] }>(
  where: Where,
  clauses: Where[]
): void {
  if (clauses.length === 0) {
    return;
  }
  where.AND = where.AND
    ? [...(Array.isArray(where.AND) ? where.AND : [where.AND]), ...clauses]
    : clauses;
}

/**
 * PRD-721: the toolbar's free-text search. A case-insensitive substring match
 * over the fields the row carries and the desktop list source already matches
 * (`matchesSessionsSearch`): the session name (the owner's rename or the
 * collected name), its external id, harness, repository and primary model.
 */
function applySearchFilter(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  const term = filters.search?.trim();
  if (!term) {
    return;
  }
  // Prisma's `contains` compiles to a bare ILIKE with no ESCAPE clause, so the
  // term's `%` and `_` are escaped to match literally (as the Documents and Tags
  // searches do).
  const contains = {
    contains: escapeSqlLikeLiteral(term),
    mode: "insensitive",
  } as const;
  appendAndClauses(where, [
    {
      OR: [
        { nameOverride: contains },
        { artifact: { is: { name: contains } } },
        { externalSessionId: contains },
        { harness: contains },
        { repositoryFullName: contains },
        { model: contains },
      ],
    },
  ]);
}

function applySessionFacetFilters(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  if (filters.repositories && filters.repositories.length > 0) {
    where.repositoryFullName = { in: filters.repositories };
  }
  // Multi-select harness facet takes precedence over the single-value back-compat
  // `harness` param (mirrors statuses/status).
  if (filters.harnesses && filters.harnesses.length > 0) {
    where.harness = { in: filters.harnesses };
  } else if (filters.harness) {
    where.harness = filters.harness;
  }
  // FEA-4303: match the Model filter against the PRIMARY displayed model
  // (`SessionDetail.model`) — the exact string the Sessions table paints in its
  // Model column — NOT the `tokenUsageByModel` relation. The relation includes
  // secondary/subagent models, so keying off it returned rows whose visible
  // Model column showed a DIFFERENT primary model (or a blank), an unexplained
  // mismatch. The Model facet options (`modelFilterOptions`) are sourced from
  // this same primary field, so filter, options, and column share ONE model
  // vocabulary and every returned row displays the selected model.
  if (filters.models && filters.models.length > 0) {
    where.model = { in: filters.models };
  }
  // Autonomy / cost / change / PR facets each OR their selected options; the OR
  // groups are ANDed together (and with the rest of the where) via `where.AND`,
  // which keeps them independent of the date filter's own clause on
  // `lastActivityAt`/`sessionStartedAt`.
  appendAndClauses(where, buildFacetAndClauses(filters));
}

/**
 * ISS-12251: both person filters match the session's Owner, the artifact's
 * assignee (operator ruling, Kerensa Whitlock 2026-10-13: "If the UI says owner, it
 * should filter by owner. The owner is the assignee.").
 *
 *   • `userIds` — the Owner facet's multi-select.
 *   • `userId` — the singular deep link. Skipped under `viewerScope=self`, which
 *     pins the viewer instead ({@link applyViewerScope}).
 *
 * FEA-4304: the two AND on the one column rather than one replacing the other,
 * so the Owner facet can never widen the scoped `userId`. Sending both returns
 * their intersection: nothing unless `userId` is in `userIds`. The typed-SQL
 * statements fold the same intersection into `ownerUserIds`
 * (`usage-summary-sql.ts`), so the shadow comparisons stay at parity.
 */
function applyArtifactPersonFilters(
  artifactWhere: Prisma.ArtifactWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  const assignee: Prisma.StringNullableFilter<"Artifact"> = {};
  if (filters.userIds && filters.userIds.length > 0) {
    assignee.in = filters.userIds;
  }
  if (filters.userId && filters.viewerScope !== AgentSessionViewerScope.Self) {
    assignee.equals = filters.userId;
  }
  if (assignee.in !== undefined || assignee.equals !== undefined) {
    artifactWhere.assigneeId = assignee;
  }
}

/**
 * Collect the per-facet OR clauses that compose under `where.AND` (autonomy
 * tier, cost bucket, change presence, PR association). Extracted from
 * {@link applySessionFacetFilters} so each facet stays a single append while the
 * caller keeps a low cognitive-complexity footprint.
 */
function buildFacetAndClauses(
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): Prisma.SessionDetailWhereInput[] {
  const andClauses: Prisma.SessionDetailWhereInput[] = [];
  for (const clause of [
    buildAutonomyTierWhere(filters.autonomyTiers),
    buildCostBucketWhere(filters.costBuckets),
    buildChangePresenceWhere(filters.changePresence),
    buildPrAssociationWhere(filters.prAssociation),
  ]) {
    if (clause) {
      andClauses.push(clause);
    }
  }
  return andClauses;
}

/**
 * OR the selected autonomy-tier ranges into one clause. Scores are the 0–100
 * autonomy column; the tier boundaries are the SSOT in
 * `@repo/api/src/agent-session-filters`. "unknown" is the null-autonomy rows.
 */
function buildAutonomyTierWhere(
  tiers: readonly string[] | undefined
): Prisma.SessionDetailWhereInput | null {
  if (!tiers || tiers.length === 0) {
    return null;
  }
  const clauses: Prisma.SessionDetailWhereInput[] = [];
  for (const tier of tiers) {
    const range = autonomyTierRange(tier);
    if (!range) {
      continue;
    }
    clauses.push({
      autonomy: range.isNull
        ? null
        : {
            ...(range.gte === undefined ? {} : { gte: range.gte }),
            ...(range.lt === undefined ? {} : { lt: range.lt }),
          },
    });
  }
  return clauses.length > 0 ? { OR: clauses } : null;
}

/**
 * A session's cost is KNOWN — the Cost cell renders a `$` figure rather than "—"
 * — when it did measurable work AND (a real captured cost was priced
 * (`estimatedCost > 0`) OR the session is billed through a subscription, which
 * still shows a `$` figure at $0). This is the SQL twin of the
 * `sessionCostIsNumeric` JS SSOT, INCLUDING its ISS-4418 measurable-work gate:
 * `deriveCostAvailability` renders "—" for a no-work session BEFORE it looks at
 * billing mode, so a no-work subscription $0 session is UNKNOWN, not "≤ $1". A
 * priced cost (`estimatedCost > 0`) is itself proof of work, so the substantive
 * gate only has to guard the subscription-$0 branch.
 */
const SESSION_COST_KNOWN_WHERE: Prisma.SessionDetailWhereInput = {
  OR: [
    { estimatedCost: { gt: 0 } },
    {
      AND: [
        { billingMode: { in: [...SUBSCRIPTION_BILLING_MODES] } },
        SESSION_SUBSTANTIVE_WHERE,
      ],
    },
  ],
};

/**
 * ISS-4481: the SQL twin of `matchesUnknownCost` — a session whose cost is UNKNOWN
 * (the Cost cell renders "—"): a NON-subscription session with a non-positive
 * `estimatedCost`. The exact complement of `SESSION_COST_KNOWN_WHERE`, so the
 * "Unknown" filter option and the "—" render share one definition and never
 * overlap a numeric bucket or a genuine $0.00 subscription (which is KNOWN).
 *
 * ISS-7176: `estimatedCost` is the sole cost authority now, on both this filter
 * and the list/detail displays — there is no separate reconciled per-event value
 * for it to diverge from, and no reconciled path this clause needs to defer to.
 *
 * It is the EXACT complement of `SESSION_COST_KNOWN_WHERE`: a cost is unknown when
 * `estimatedCost <= 0` AND the session is NOT a worked subscription — i.e. either
 * non-subscription (null billingMode or a non-subscription mode) OR a subscription
 * that did no measurable work (ISS-4481, mirroring the JS SSOT's ISS-4418
 * measurable-work gate). The `billingMode` branch is an explicit
 * `OR [is null, notIn subscription]`, NOT a bare `notIn`: in SQL a `NOT IN`
 * predicate is NULL (not TRUE) for a NULL column, so a bare `notIn` would silently
 * DROP the most common unknown-cost row — a non-subscription session whose
 * `billingMode` is null. The added `subscription AND idle` disjunct closes the
 * no-work-subscription gap so this clause and `SESSION_COST_KNOWN_WHERE` partition
 * every row.
 */
const SESSION_COST_UNKNOWN_WHERE: Prisma.SessionDetailWhereInput = {
  AND: [
    // ISS-7176: `estimatedCost` is NULLABLE now, and null IS the unknown case —
    // it is what the desktop's authoritative rollup stores when nothing was
    // priced. It must be admitted EXPLICITLY: in SQL `NULL <= 0` evaluates to
    // NULL, not TRUE, so the bare `lte` this replaces matched no null row. That
    // is the same three-valued-logic trap the `billingMode` disjunct below
    // already documents, and left unfixed it would drop every unknown-cost
    // session out of BOTH this clause and `SESSION_COST_KNOWN_WHERE` — visible
    // as rows vanishing from the Unknown filter rather than as an error.
    { OR: [{ estimatedCost: null }, { estimatedCost: { lte: 0 } }] },
    {
      OR: [
        { billingMode: null },
        { billingMode: { notIn: [...SUBSCRIPTION_BILLING_MODES] } },
        {
          AND: [
            { billingMode: { in: [...SUBSCRIPTION_BILLING_MODES] } },
            SESSION_IDLE_WHERE,
          ],
        },
      ],
    },
  ],
};

/**
 * OR the selected cost-filter options into one clause. estimatedCost is a Decimal
 * column; Prisma accepts JS numbers for its comparators. The numeric buckets and
 * the ISS-4481 Unknown option compose OR-within the dimension: a row matches if it
 * falls in a selected numeric bucket OR (when Unknown is selected) its cost is
 * unknown.
 *
 * FEA-4293: the bounds come from `costBucketRawBounds`, which half-cent-shifts
 * each bucket edge so the RAW-column predicate selects exactly the rows whose
 * DISPLAYED (2dp-rounded) cost falls in the bucket, on Marisol's INCLUSIVE upper /
 * exclusive lower partition. A raw `1.0` that displays `$1.00` is INCLUDED in
 * "≤ $1" (and excluded from "$1 to $10"), matching the reconciled/desktop
 * matchers that round in memory.
 *
 * FEA-4294: every numeric-bucket clause is ANDed with `SESSION_COST_KNOWN_WHERE`
 * so a session whose cost is UNKNOWN (renders "—") never satisfies a numeric
 * bucket, even though its `estimatedCost` column stores a 0 that would otherwise
 * fall in "≤ $1". ISS-4481: the Unknown option is the disjoint complement clause.
 */
function buildCostBucketWhere(
  buckets: readonly string[] | undefined
): Prisma.SessionDetailWhereInput | null {
  if (!buckets || buckets.length === 0) {
    return null;
  }
  // shafty thread (ISS-4481): an EXHAUSTIVE selection (every numeric bucket AND
  // Unknown) covers every row — a no-op filter. Return null so the query carries
  // no cost clause at all, matching the reconciled-path gate that treats an
  // exhaustive selection as "no cost filter".
  if (isExhaustiveCostFilter(buckets)) {
    return null;
  }
  const numericClauses: Prisma.SessionDetailWhereInput[] = [];
  for (const bucketId of buckets) {
    const bucket = getSessionCostBucket(bucketId);
    if (!bucket) {
      continue;
    }
    const { gte, lt } = costBucketRawBounds(bucket);
    numericClauses.push({
      estimatedCost: {
        gte,
        ...(lt === null ? {} : { lt }),
      },
    });
  }
  const optionClauses: Prisma.SessionDetailWhereInput[] = [];
  if (numericClauses.length > 0) {
    optionClauses.push({
      AND: [{ OR: numericClauses }, SESSION_COST_KNOWN_WHERE],
    });
  }
  if (costFilterIncludesUnknown(buckets)) {
    optionClauses.push(SESSION_COST_UNKNOWN_WHERE);
  }
  if (optionClauses.length === 0) {
    return null;
  }
  return optionClauses.length === 1 ? optionClauses[0] : { OR: optionClauses };
}

/**
 * OR the selected change-presence options into one clause. "has_changes" keeps
 * only sessions with a non-zero diff; "no_changes" keeps their null-safe
 * complement. Selecting both is a no-op (every row satisfies one side).
 */
function buildChangePresenceWhere(
  options: readonly string[] | undefined
): Prisma.SessionDetailWhereInput | null {
  if (!options || options.length === 0) {
    return null;
  }
  const clauses: Prisma.SessionDetailWhereInput[] = [];
  for (const option of options) {
    if (option === SessionChangePresenceId.HasChanges) {
      clauses.push(SESSION_HAS_CHANGES_WHERE);
    } else if (option === SessionChangePresenceId.NoChanges) {
      clauses.push(SESSION_NO_CHANGES_WHERE);
    }
  }
  return clauses.length > 0 ? { OR: clauses } : null;
}

/**
 * OR the selected pull-request association options into one clause. "has_pr"
 * keeps sessions with a legacy-JSON or artifact-link PR; "no_pr" keeps their
 * complement. Selecting both is a no-op (P OR NOT P).
 */
function buildPrAssociationWhere(
  options: readonly string[] | undefined
): Prisma.SessionDetailWhereInput | null {
  if (!options || options.length === 0) {
    return null;
  }
  const clauses: Prisma.SessionDetailWhereInput[] = [];
  for (const option of options) {
    if (option === SessionPrAssociationId.HasPr) {
      clauses.push(SESSION_HAS_PR_WHERE);
    } else if (option === SessionPrAssociationId.NoPr) {
      clauses.push({ NOT: SESSION_HAS_PR_WHERE });
    }
  }
  return clauses.length > 0 ? { OR: clauses } : null;
}

function applyArtifactFacetFilters(
  artifactWhere: Prisma.ArtifactWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  applyArtifactPersonFilters(artifactWhere, filters);
  // ISS-12251 D-4: team scope is "sessions created by a member of the team",
  // the `tm.user_id = a.created_by_id` predicate `facet-common.sql` applies.
  if (filters.teamId) {
    artifactWhere.createdBy = {
      is: { teamMemberships: { some: { teamId: filters.teamId } } },
    };
  }
  if (filters.projectId) {
    artifactWhere.projectId = filters.projectId;
  }
  // ISS-5355: the Project FACET is a different dimension from the singular
  // `projectId` scope above, so the two simply AND rather than intersect.
  // `projectId` asks "is this session's own artifact parented to the project?" —
  // which is never true for a synced session, because a SessionDetail artifact
  // is created unparented. The facet asks the question the user means: "did
  // this session touch an artifact IN the project?", which is the session→
  // document link the detail view already renders as "linked artifacts"
  // (ISS-5236 — see `toLinkedArtifactProjection`, the same `sourceLinks` edge
  // filtered to DOCUMENT targets). One linkage path, not two.
  const projectIds = filters.projectIds ?? [];
  if (projectIds.length > 0) {
    artifactWhere.sourceLinks = {
      some: buildProjectLinkWhere(projectIds),
    };
  }
  const priorityWhere = buildPriorityFacetWhere(filters.priorities);
  if (priorityWhere) {
    appendAndClauses(artifactWhere, [priorityWhere]);
  }
  applyStatusFacetFilter(artifactWhere, filters);
}

/**
 * ISS-9939 / ISS-10629: the Sessions status FILTER is a plain equality against
 * the persisted `artifacts.status` column — active/inactive/error, the same
 * three values SORT already moved to in ISS-10262. It is deliberately no
 * longer the projected Waiting/Active-exclusion/Stale/Unknown/reconciliation
 * predicate `buildStatusFacetPredicate` used to build here. That predicate and
 * the `status-facet-predicate.ts` module around it are DELETED (ISS-10629
 * follow-through): `status-counts.ts` moved onto this same equality in the
 * same ruling, so nothing was left calling it.
 *
 * DISPLAY is unchanged: a session that BADGES Waiting or Stale still stores
 * `active` and still matches an Active filter — it is simply no longer
 * isolatable as its own filter value, the accepted capability loss the ruling
 * names. A status value that is not one of the three persisted ones (a stale
 * bookmarked `?status=waiting`, a retired `completed`/`abandoned` spelling)
 * matches nothing, the same honest fallthrough every other unrecognized
 * status value already gets.
 *
 * Covers both the `statuses` multi-select and the single-value `status`
 * back-compat param via the shared {@link resolvePersistedStatusFilter}.
 */
function applyStatusFacetFilter(
  artifactWhere: Prisma.ArtifactWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  const statuses = resolvePersistedStatusFilter(filters);
  if (statuses === null) {
    return;
  }
  artifactWhere.status = statuses.length === 1 ? statuses[0] : { in: statuses };
}

function applyDateFilter(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery,
  dateField: "sessionStartedAt" | "lastActivityAt"
): void {
  if (filters.startDate || filters.endDate) {
    const range = {
      ...(filters.startDate ? { gte: new Date(filters.startDate) } : {}),
      ...(filters.endDate ? { lte: new Date(filters.endDate) } : {}),
    };
    if (dateField === "lastActivityAt") {
      // The Sessions list is ordered by lastActivityAt, so the window must
      // filter on the same field — "active in this window", not "started in
      // this window" — otherwise a recently-active session that started before
      // the window ranks at the top yet gets filtered out (the dashboard /
      // Sessions-list mismatch, FEA-2180).
      //
      // ISS-6463: one comparison, not a disjunction. The second branch existed
      // for pre-backfill rows with a null lastActivityAt; the column is NOT NULL
      // now, so it matched nothing. Assigning the field rather than `where.OR`
      // also stops this from clobbering a disjunction another filter owns.
      where.lastActivityAt = range;
    } else {
      where.sessionStartedAt = range;
    }
  }
}

/**
 * FEA-3009: apply the completion-time lower bound. `completedAfter` keeps only
 * sessions that COMPLETED at or after the given instant, filtered on
 * `sessionEndedAt` (the terminal timestamp) rather than `startDate`'s
 * `lastActivityAt`/`sessionStartedAt` window — so a session that started before
 * the boundary but ended after it IS kept, and one that ended before it is not.
 * A `gte` on the nullable `sessionEndedAt` column never matches a NULL row in
 * SQL three-valued logic, so still-running sessions (no `sessionEndedAt`) are
 * excluded without an explicit `not: null` guard. ANDed so it composes with the
 * date window and every facet. Mirrored on desktop by `matchesCompletedAfter`.
 */
function applyCompletionFilter(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  if (!filters.completedAfter) {
    return;
  }
  appendAndClauses(where, [
    { sessionEndedAt: { gte: new Date(filters.completedAfter) } },
  ]);
}

/**
 * Map a sort column + direction (from the table headers) to a Prisma `orderBy`.
 *
 * Delegates to the single source of truth in `session-sort-order.ts`, which owns
 * the FEA-4329 unique tiebreaker and FEA-4330 nulls-last invariants for every
 * column. The two display-value sorts (duration/user, FEA-4297/FEA-4300) are
 * resolved in memory (see `isDisplayValueSort`); this returns their deterministic
 * candidate pre-scan order.
 */
export function buildAgentSessionOrderBy(
  filters: AgentSessionListQuery
): Prisma.SessionDetailOrderByWithRelationInput[] {
  return buildDbSortOrderBy(filters);
}

export async function findSourceArtifactsById(
  organizationId: string,
  sourceArtifactIds: Iterable<string | null | undefined>
): Promise<Map<string, SourceArtifactSummaryRecord>> {
  const ids = [...new Set([...sourceArtifactIds].filter(isUuid))];
  if (ids.length === 0) {
    return new Map();
  }

  const artifacts = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        id: { in: ids },
      },
      select: sourceArtifactSummarySelect,
    })
  );

  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

export async function findPagedRecords<TRecord extends { artifactId: string }>(
  fetchPage: (cursorId?: string) => Promise<TRecord[]>
): Promise<TRecord[]> {
  const sessions: TRecord[] = [];
  let cursorId: string | undefined;

  for (;;) {
    const page = (await fetchPage(cursorId)) ?? [];

    sessions.push(...page);

    if (page.length < ANALYTICS_QUERY_BATCH_SIZE) {
      return sessions;
    }

    cursorId = page.at(-1)?.artifactId;
    if (!cursorId) {
      return sessions;
    }
  }
}

export function buildLastSyncTargetWhere(
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery
): Prisma.ComputeTargetWhereInput {
  const where: Prisma.ComputeTargetWhereInput = {
    organizationId: scope.organizationId,
    // FEA-2923: exclude the synthetic per-org "cloud" sentinel target so it is
    // never counted as a synced device in the usage/last-sync dashboard.
    isCloudSentinel: false,
  };

  if (filters.userId) {
    where.userId = filters.userId;
  }
  if (filters.teamId) {
    where.user = {
      is: {
        teamMemberships: {
          some: {
            teamId: filters.teamId,
          },
        },
      },
    };
  }

  return where;
}

/**
 * The statuses a filter set requests, covering both the `statuses` multi-select
 * and the single-value `status` back-compat param. Empty when neither is set.
 *
 * ISS-8858 had this exported from `status-facet-predicate.ts` so the counts read
 * could share it with the list. ISS-10629 deleted that module — the display
 * projection it existed for has no callers left — and this returned here,
 * unexported, to {@link applyStatusFacetFilter}.
 *
 * RAW, and therefore not what a predicate may be built from: the retirement
 * strip below is the other half. {@link resolvePersistedStatusFilter} is the
 * one a caller wants.
 */
function resolveRequestedStatuses(
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): string[] {
  if (filters.statuses && filters.statuses.length > 0) {
    return filters.statuses;
  }
  return filters.status ? [filters.status] : [];
}

/**
 * The WHOLE status resolution — both spellings reconciled AND the retired
 * display values stripped — as the three-valued answer any status predicate
 * needs. ISS-10753 exports it because the TypedSQL summary composer
 * (`usage-summary-sql.ts`) builds its own predicate now; returning the raw
 * resolver to it would have shipped half of this, and the half it left behind
 * is the half that changes the answer.
 *
 * `null` — no status selection, no narrowing.
 * `[]`   — every requested value was a display-only status no producer
 *          persists (`waiting`/`unknown`/`stale`). That is a request for a
 *          population that cannot exist, NOT an absent filter: `artifacts.status`
 *          is freeform and rows literally storing `waiting` exist, so falling
 *          through to "no predicate" would widen it to every session — the exact
 *          silent widening the retirement prevents, and what the published API
 *          and MCP docs promise it does not do (davetho review, ISS-10629).
 * non-empty — the values to compare the stored column against. An unrecognised
 *          spelling that is not display-only (a retired `completed`) stays in
 *          and matches nothing on its own, the honest fallthrough it already got.
 *
 * Both consumers map that onto their own "match nothing" spelling —
 * `status: { in: [] }` for Prisma, an empty `text[]` against the
 * `$16::text[] IS NULL` guard for the statements — so neither has to re-derive
 * which values are selectable.
 */
export function resolvePersistedStatusFilter(
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): string[] | null {
  const requested = resolveRequestedStatuses(filters);
  if (requested.length === 0) {
    return null;
  }
  return requested.filter(
    (status) =>
      !(RETIRED_DISPLAY_FACET_SPELLINGS as readonly string[]).includes(status)
  );
}
