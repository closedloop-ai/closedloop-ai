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
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import {
  DISPLAYED_SESSION_STATUS,
  normalizeSessionStatus,
  RECOGNIZED_SESSION_STATUS_VALUES,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
  TERMINAL_SESSION_STATUSES,
} from "@repo/api/src/types/session-status";
import { Prisma, withDb } from "@repo/database";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "../validators";
import { isUuid } from "./coercion";
import { buildProjectLinkWhere } from "./project-link-where";
import { toAgentSessionState } from "./projections";
import {
  type AgentSessionScope,
  type SourceArtifactSummaryRecord,
  sourceArtifactSummarySelect,
} from "./records";
import { buildDbSortOrderBy } from "./session-sort-order";

export const ANALYTICS_QUERY_BATCH_SIZE = 200;

// FEA-4298: the single date field the whole Sessions SURFACE windows on — the
// table/list AND the summary cards above it. For a given date range these are
// ONE cohort (the cards summarize exactly the population the table lists), so
// both must window on the same timestamp column with the same null-handling, or
// the cards reconcile against a different set than the table shows. The list is
// ordered by `lastActivityAt` and windows on it (FEA-2180: "active in this
// window", with the null-safe fallback to `sessionStartedAt` in
// `applyDateFilter`), so the summary read is pinned to the SAME field here
// rather than the analytics/export default of `sessionStartedAt`. Both
// `findSessions` (table) and `getUsageSummary` (cards) pass this constant to
// `buildWhere`, so the two cohorts cannot silently drift onto different columns.
export const SESSIONS_SURFACE_DATE_FIELD = "lastActivityAt" as const;

// The analytics read's date field: a session belongs to the period it STARTED
// in (`buildWhere`'s default), distinct from the list/summary "active in this
// window" `lastActivityAt`. Named so the analytics cohort's cost-reconciled
// `buildUsageSummaryWhere` call (ISS-4481 thread wongk) keeps its own window
// semantics while sharing the reconciled cost-bucket resolution.
export const SESSIONS_ANALYTICS_DATE_FIELD = "sessionStartedAt" as const;

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
              metadata: {
                path: ["linkKind"],
                equals: SessionArtifactLinkKind.SessionPr,
              },
            },
          },
        },
      },
    },
  ],
};

// FEA-3284: the SQL twin of the `isSubstantiveSession` JS SSOT
// (`@repo/api/src/agent-session-filters`). A session is substantive when it has
// at least one turn, OR any token was consumed (input + output + cache read +
// cache write), OR at least one tool was used. `turns` is a nullable Int (null =
// no signal → idle); the token/tool columns are non-null with a 0 default. This
// OR is kept byte-for-byte equivalent to the JS predicate and the desktop read
// (`isSubstantiveSession` on the hydrated session) so a row buckets as idle vs
// substantive identically on cloud, desktop, and the shared UI — the FEA-3149
// lockstep contract. Any edit here MUST be mirrored in both twins.
const SESSION_SUBSTANTIVE_WHERE: Prisma.SessionDetailWhereInput = {
  OR: [
    { turns: { gt: 0 } },
    { inputTokens: { gt: 0 } },
    { outputTokens: { gt: 0 } },
    { cacheReadTokens: { gt: 0 } },
    { cacheWriteTokens: { gt: 0 } },
    { toolUseCount: { gt: 0 } },
  ],
};

// The null-safe complement of SESSION_SUBSTANTIVE_WHERE: an idle session has no
// turn (null or <= 0) AND zero of every token AND no tool use. Expressed
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
  ],
};

// PLN-1034: the Sessions list default order and the per-column order-by now live
// in the single source of truth `session-sort-order.ts`, which owns the
// FEA-4329 unique tiebreaker and FEA-4330 nulls-last invariants; `buildAgentSessionOrderBy`
// below re-exports the DB-native builder for the existing call sites.

export function buildWhere(
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
): Prisma.SessionDetailWhereInput {
  // Hoisted fields (organizationId, projectId, and plain-equality statuses) are
  // filtered through the parent `artifact` relation; session-specific fields
  // (userId, harness, sessionStartedAt) stay on the detail row. The Waiting and
  // Active status facets are the exception — they reference SessionDetail fields
  // (`awaitingInputSince`/`sessionEndedAt`) and so are built at the session level
  // in `applyStatusFacetFilter`, not here.
  const artifactWhere: Prisma.ArtifactWhereInput = {
    organizationId: scope.organizationId,
  };
  const where: Prisma.SessionDetailWhereInput = {
    artifact: { is: artifactWhere },
  };

  if (isMissingTeamScope(filters)) {
    where.artifactId = { in: [] };
    return where;
  }

  applySessionFacetFilters(where, filters);
  applyArtifactFacetFilters(artifactWhere, filters);
  // ISS-4559: the per-viewer `sessions-displayed-status-parity` gate, resolved at
  // the route and carried on the scope. Absent (every internal/legacy caller) it
  // reads false, which is the pre-ISS-4559 predicate.
  applyStatusFacetFilter(where, filters, scope.displayedStatusParity === true);
  applyQualityFilter(where, filters);
  applyDateFilter(where, filters, dateField);
  applyCompletionFilter(where, filters);
  applyViewerScope(where, scope, filters);

  return where;
}

/**
 * FEA-3534: enforce `viewerScope=self` server-side. Historically the "Me" scope
 * on the dashboard / personal Sessions page was only a client courtesy — the
 * request passed a `userId` filter (or, in the Recent Sessions card, nothing at
 * all), and the server never pinned the result to the authenticated user, so a
 * dropped/forged param silently widened the read to the whole org. When the
 * viewer asks for self scope we OVERRIDE any client-sent user filter with the
 * authenticated viewer's own id, so a self read can never return another user's
 * sessions. Applied LAST (after `applySessionFacetFilters` set `where.userId`
 * from the client params) so self scope wins. A self request without a resolved
 * `viewerId` fails closed to an impossible predicate rather than leaking org-wide
 * rows.
 */
function applyViewerScope(
  where: Prisma.SessionDetailWhereInput,
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  if (filters.viewerScope !== AgentSessionViewerScope.Self) {
    return;
  }
  where.userId = scope.viewerId ?? { in: [] };
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
export function buildIdleCountWhere(
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery | AgentSessionListQuery,
  dateField: "sessionStartedAt" | "lastActivityAt" = "sessionStartedAt"
): Prisma.SessionDetailWhereInput {
  // Reuse buildWhere with quality forced OFF (so it carries every OTHER filter
  // but not the substantive clause), then AND the idle complement.
  const where = buildWhere(scope, { ...filters, quality: "all" }, dateField);
  appendAndClauses(where, [SESSION_IDLE_WHERE]);
  return where;
}

function isMissingTeamScope(
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
function appendAndClauses(
  where: Prisma.SessionDetailWhereInput,
  clauses: Prisma.SessionDetailWhereInput[]
): void {
  if (clauses.length === 0) {
    return;
  }
  where.AND = where.AND
    ? [...(Array.isArray(where.AND) ? where.AND : [where.AND]), ...clauses]
    : clauses;
}

function applySessionFacetFilters(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  applyUserScope(where, filters);
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
  // which keeps them independent of the date filter's own `where.OR` clause.
  appendAndClauses(where, buildFacetAndClauses(filters));
}

/**
 * FEA-4304: apply the user scope as an AND constraint that the Owner facet can
 * never silently widen.
 *
 * Two params can carry a user cohort: the single-value `userId` (the FIXED
 * cross-surface scope — e.g. the user-scoped deep link, whose badge claims
 * "Showing sessions for the selected user") and the `userIds` multi-select (the
 * Owner facet). The prior code let a nonempty `userIds` REPLACE `userId`, so an
 * alternate Owner value reaching the request (stale UI state, a saved view, or a
 * crafted query) widened/replaced the supposedly fixed scope while the UI badge
 * still claimed the scope was intact — leaking another user's sessions under a
 * false label. Because both the list and summary/usage reads resolve through this
 * one seam (`buildWhere` → `applySessionFacetFilters`), that leak affected both.
 *
 * The invariant: a scoped `userId` is an AND constraint. When both are present,
 * intersect them — the Owner facet may only NARROW within the scoped user, never
 * widen past it:
 *   • `userIds` includes the scoped user  → pin to the scoped user (the facet is
 *     redundant or a superset; the AND collapses to the single user).
 *   • `userIds` excludes the scoped user  → the intersection is empty, so pin to
 *     an impossible predicate (`{ in: [] }`) rather than honoring the wider facet.
 *     The scoped user is never violated; the request simply returns no rows.
 * With no scoped `userId`, the Owner facet stands alone (its `in` set); with no
 * facet, the scoped `userId` stands alone. The later `viewerScope=self` override
 * (`applyViewerScope`) is a stricter self-pin and still wins on top of this.
 */
function applyUserScope(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery
): void {
  const facetUserIds =
    filters.userIds && filters.userIds.length > 0 ? filters.userIds : undefined;
  const scopedUserId = filters.userId;

  if (scopedUserId) {
    // Scoped `userId` present: AND with the facet. Honor the facet only when it
    // keeps the scoped user in the cohort; otherwise the intersection is empty.
    where.userId =
      facetUserIds && !facetUserIds.includes(scopedUserId)
        ? { in: [] }
        : scopedUserId;
    return;
  }
  if (facetUserIds) {
    where.userId = { in: facetUserIds };
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
 * NOTE: this DB clause keys on the STALE `estimatedCost` rollup, so a legacy row
 * whose rollup is 0 but whose reconciled per-event cost is > 0 would be mislabeled
 * unknown here. That divergence is exactly why the Unknown filter routes through
 * the reconciled path (`isCostReconciliationSensitiveQuery`), where the match runs
 * on the reconciled value; this clause is the DB twin kept correct as a fallback
 * for any non-reconciled caller.
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
  estimatedCost: { lte: 0 },
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
 * DISPLAYED (2dp-rounded) cost falls in the bucket, on Mike's INCLUSIVE upper /
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
  // Status is NOT a plain `artifact.status` match: the Waiting and Active facets
  // derive from `awaitingInputSince` (a SessionDetail field), so the predicate
  // spans both tables and is built at the session level — see
  // {@link applyStatusFacetFilter}.
}

/**
 * ISS-4559: the SQL statement of "this row DISPLAYS as Waiting", minus the raw
 * status test each branch carries itself — `awaitingInputSince` set AND the
 * session has not ended. It is the SQL half of
 * `projectDisplayedSessionStatus`'s Waiting condition
 * (`session-status-projection.ts`).
 *
 * Stated once and used in opposite senses: WAITING selects it (with the
 * non-terminal status test), ACTIVE and the raw-status fallback exclude it via
 * {@link DOES_NOT_DISPLAY_AS_WAITING} (with their own status tests). That is the
 * whole point — a row is excluded from Active EXACTLY when it projects to
 * Waiting, so the two facets partition the awaiting-input rows between them and
 * none can fall through both. Two parallel conditions is what drifted in the
 * first place.
 */
const DISPLAYS_AS_WAITING: Prisma.SessionDetailWhereInput = {
  awaitingInputSince: { not: null },
  sessionEndedAt: null,
};

/**
 * ISS-4559: the NEGATION of {@link DISPLAYS_AS_WAITING}, written as an explicit
 * disjunction rather than as `NOT: DISPLAYS_AS_WAITING`.
 *
 * Prisma 7.8 does compile a multi-key `NOT` as the GROUPED
 * `NOT(a AND b)` — verified against real Postgres, which emits
 * `NOT ("awaitingInputSince" IS NOT NULL AND "sessionEndedAt" IS NULL)` and
 * returns the same rows as this disjunction. But Prisma's own documented gloss
 * for `NOT` ("all conditions must return false") reads as the DISTRIBUTED
 * `NOT(a) AND NOT(b)`, which is a different predicate that would drop every live
 * running session from the Active facet. Spelling the disjunction out means the
 * predicate does not depend on resolving that ambiguity, and it reads the same
 * to the next person as it does to the query compiler.
 *
 * It also keeps the clause composable. `NOT` is a single reserved key in a
 * `where` object, so a branch that needs BOTH this exclusion and another
 * negation (the ISS-5366 staleness cutoff, in the ACTIVE branch below) cannot
 * express them as two `NOT`s — the second silently overwrites the first.
 */
const DOES_NOT_DISPLAY_AS_WAITING: Prisma.SessionDetailWhereInput = {
  OR: [{ awaitingInputSince: null }, { sessionEndedAt: { not: null } }],
};

/**
 * Build the where-predicate for a single canonical status facet, mirroring the
 * two desktop implementations (`matchesStatusFilter` in
 * `shared-agent-sessions-api.ts` and `buildUsageStatusPredicate` in
 * `sync-source.ts`) so the shared UI's canonical `SESSION_STATUS` value buckets
 * sessions identically on every surface:
 *   • `waiting` → an awaiting-input session: `awaitingInputSince` is set, the
 *     session has not ended (`sessionEndedAt` is null), and the status is
 *     non-terminal (matching `status = 'waiting'` returns nothing, because that
 *     value is never persisted). The `sessionEndedAt: null` guard mirrors the
 *     projection in {@link toAgentSessionState}, which only reports
 *     PendingApproval while `!sessionEndedAt` — an ended-but-not-yet-canonicalized
 *     row projects to a terminal state and so must not surface as Waiting. Cloud
 *     persists the raw canonical status (`error`, never the desktop-local
 *     `failed` alias), so the shared canonical {@link TERMINAL_SESSION_STATUSES}
 *     set ({inactive, error}) is exactly the terminal set to exclude
 *     here. The retired spellings are NOT unioned back in: ISS-5981's total
 *     ingest fold means no row can store one.
 *   • `active` → `status = 'active'` AND the row does not display as Waiting
 *     ({@link DISPLAYS_AS_WAITING} negated), so awaiting-input sessions are
 *     excluded exactly while they would render as Waiting.
 *   • anything else → a plain `artifact.status` equality.
 *
 * FEA-4301: the Status-column SORT projects the same displayed status via
 * `projectDisplayedSessionStatus` (`session-status-projection.ts`) — the SQL
 * WAITING predicate here and that JS projection are the one derivation, so a
 * displayed-Waiting row sorts, filters, and renders as Waiting consistently.
 *
 * ISS-4559: that was true of WAITING but NOT of ACTIVE, which carried an extra
 * `awaitingInputSince: null` with no counterpart in the projection — so an ended +
 * awaiting-input row displayed Active and was returned by neither facet. Behind
 * `displayedStatusParity` the ACTIVE branch negates the WAITING clause instead,
 * making "excluded from Active" and "projects to Waiting" one statement.
 */
/**
 * ISS-5366: the SQL half of the display staleness cutoff — the two branches that
 * together mean "this row's staleness anchor is older than the threshold".
 *
 * Two branches rather than one because the anchor is `lastActivityAt ?? started`
 * (the reaper's own fallback, mirrored by `resolveDisplayedSessionStatus`) and
 * Prisma has no COALESCE in `where`. Reading only `lastActivityAt` would exempt
 * precisely the least-evidenced rows — a null activity timestamp is no evidence
 * of life, not evidence of freshness.
 *
 * Built fresh per call so the cutoff is computed against the CURRENT request
 * rather than a module-load constant that would drift stale over a long-lived
 * server process.
 */
function buildStaleAnchorBranches(): Prisma.SessionDetailWhereInput[] {
  const cutoff = new Date(
    Date.now() - STALE_SESSION_DISPLAY_THRESHOLD_HOURS * 60 * 60 * 1000
  );
  return [
    // ISS-4556: the `not: null` is load-bearing, not defensive. `lastActivityAt`
    // is nullable, and a bare `last_activity_at < $cutoff` is SQL NULL — not
    // FALSE — for a null column. The ACTIVE facet negates this disjunction, and
    // `NOT NULL` is NULL, which SQL's WHERE rejects: a row with a null activity
    // timestamp and a FRESH `sessionStartedAt` (branch two false) was returned by
    // NEITHER Active nor Stale while displaying Active, the same invisible-row
    // defect this batch exists to close, one column over. Making the branch
    // FALSE rather than NULL for those rows keeps the negation two-valued and
    // the two facets exact complements.
    { lastActivityAt: { not: null, lt: cutoff } },
    { lastActivityAt: null, sessionStartedAt: { lt: cutoff } },
  ];
}

/**
 * ISS-5366: the statuses a row can store and NOT display as "Unknown".
 *
 * Every value the display fold recognizes, minus `unknown` itself — a row that
 * literally stores `unknown` does display as Unknown, so it must not be
 * excluded from the facet that gathers them. `stale` stays in the list because
 * it folds to Stale, not Unknown.
 */
const UNKNOWN_EXCLUDED_STATUS_VALUES = RECOGNIZED_SESSION_STATUS_VALUES.filter(
  (value) => value !== DISPLAYED_SESSION_STATUS.UNKNOWN
);

function buildStatusFacetPredicate(
  status: string,
  displayedStatusParity = false
): Prisma.SessionDetailWhereInput {
  if (status === DISPLAYED_SESSION_STATUS.WAITING) {
    const projectedWaiting: Prisma.SessionDetailWhereInput = {
      ...DISPLAYS_AS_WAITING,
      artifact: {
        is: {
          status: { notIn: [...TERMINAL_SESSION_STATUSES] },
        },
      },
    };
    if (!displayedStatusParity) {
      return projectedWaiting;
    }
    // ISS-4559: `waiting` is BOTH a projected display value and a legacy
    // PERSISTED one (`DISPLAYED_SESSION_STATUS.WAITING`, kept for version-skew until the
    // vocabulary migration runs). A row literally stored `waiting` DISPLAYS as
    // Waiting — `projectDisplayedSessionStatus` returns the raw status whenever
    // the projection does not fire — yet matched NEITHER facet: this branch
    // demanded `awaitingInputSince`, and ACTIVE demands `status = 'active'`. Same
    // invisible-row defect as the ended + awaiting case, through a different
    // door. Union the stored value in so the facet covers every way a row can
    // come to display Waiting.
    return { OR: [projectedWaiting, { artifact: { is: { status } } }] };
  }
  if (status === SESSION_STATUS.ACTIVE) {
    // ISS-4559: ON, exclude a row from Active EXACTLY when it projects to
    // Waiting — the SAME clause the WAITING branch above selects, negated. OFF
    // (the closed-by-default rollout state), the pre-ISS-4559 predicate applies:
    // it dropped EVERY awaiting-input row regardless of `sessionEndedAt`, so an
    // ended + awaiting-input row was returned by neither facet.
    return {
      ...(displayedStatusParity
        ? DOES_NOT_DISPLAY_AS_WAITING
        : { awaitingInputSince: null }),
      artifact: { is: { status: SESSION_STATUS.ACTIVE } },
      // ISS-5366: a live-looking row silent past the cutoff DISPLAYS as Stale,
      // so it must leave the Active bucket — otherwise Status = Active returns a
      // page whose badges read "Stale", which is the contradiction this batch
      // exists to remove. `NOT` over the same two-branch anchor test the STALE
      // predicate uses keeps the two exactly complementary.
      NOT: { OR: buildStaleAnchorBranches() },
    };
  }
  if (status === DISPLAYED_SESSION_STATUS.STALE) {
    return {
      OR: [
        // A producer that literally persists `stale` (none does today) keeps the
        // plain equality the fallback branch used to give it — INCLUDING that
        // branch's waiting-exclusion, which this arm was missing.
        //
        // ISS-5656: the Waiting projection fires ahead of everything and does not
        // read the raw spelling — `stale` folds to `active`, which is
        // non-terminal — so a row storing `stale` while awaiting input BADGES
        // "Waiting". Unconditional, this arm returned it from Stale as well: one
        // row under two facets, one of them contradicting its own badge, which is
        // the double-count the UNKNOWN branch below already subtracts one status
        // over. The same declared `DOES_NOT_DISPLAY_AS_WAITING` clause ACTIVE
        // negates and the raw-status fallback spreads, read here too, so all
        // three stored-status arms subtract ONE population rather than three
        // hand-written spellings of it.
        //
        // Spread rather than wrapped in `AND` (unlike the sibling arm below):
        // this object has no `OR` key of its own for the disjunction to
        // overwrite, exactly as in the raw-status fallback.
        {
          ...(displayedStatusParity ? DOES_NOT_DISPLAY_AS_WAITING : {}),
          artifact: { is: { status: DISPLAYED_SESSION_STATUS.STALE } },
        },
        {
          // Exactly the rows the ACTIVE predicate above now excludes: the old
          // Active population PARTITIONS into Active + Stale, so no row is lost
          // between the two facets and none appears in both.
          //
          // ISS-4559: that partition only holds while BOTH branches subtract the
          // SAME awaiting-input population, so this reads the same gated clause
          // ACTIVE negates. Left on the ungated `awaitingInputSince: null`, an
          // ended + awaiting + long-silent row is dropped from Active by the
          // stale anchor and from Stale by the awaiting test — returned by
          // neither facet, which is the invisible-row defect this batch removes.
          //
          // Wrapped in `AND` rather than spread: DOES_NOT_DISPLAY_AS_WAITING is
          // written as a disjunction, and its `OR` key would silently overwrite
          // the stale-anchor `OR` below (one reserved key per `where` object).
          //
          // Matched on the literal `active` for the same reason the ACTIVE
          // branch is — a row stored under the legacy `running` alias is not
          // reachable by the Active facet today either. That narrowness is
          // pre-existing and deliberately left the same size here: widening it
          // on one side only would put a row in Stale that Active never offered.
          ...(displayedStatusParity
            ? { AND: [DOES_NOT_DISPLAY_AS_WAITING] }
            : { awaitingInputSince: null }),
          artifact: { is: { status: SESSION_STATUS.ACTIVE } },
          OR: buildStaleAnchorBranches(),
        },
      ],
    };
  }
  if (status === DISPLAYED_SESSION_STATUS.UNKNOWN) {
    // A status the display fold does not RECOGNIZE renders "Unknown"
    // (`foldSessionStatus`), as does a row literally storing `unknown`. Matching
    // by exclusion — rather than listing the unknown values, which by definition
    // cannot be listed — is what lets the facet reach a version-skewed row a
    // future producer writes.
    const unrecognized: Prisma.SessionDetailWhereInput = {
      artifact: {
        is: { status: { notIn: [...UNKNOWN_EXCLUDED_STATUS_VALUES] } },
      },
    };
    if (!displayedStatusParity) {
      return unrecognized;
    }
    // ISS-4559: `projectDisplayedSessionStatus` applies the Waiting projection
    // BEFORE the unrecognized fold, so a version-skewed row that is also
    // awaiting input DISPLAYS as Waiting, not Unknown. Without this exclusion
    // both the Waiting and the Unknown facet return it — double-counted, under a
    // facet whose name contradicts its own badge, in exactly the version-skew
    // case Unknown exists to serve.
    return { ...DOES_NOT_DISPLAY_AS_WAITING, ...unrecognized };
  }
  // ISS-4586 made `inactive` the canonical terminal-but-not-failed state, and
  // ISS-4985 widened this predicate both ways: a selected Inactive also matched
  // not-yet-migrated `completed`/`abandoned` rows, and a caller FILTERING by a
  // retired spelling was routed here rather than falling through to an exact
  // match on a value the vocabulary no longer had.
  //
  // ISS-5592 removed both directions. The ingest fold makes either spelling
  // unwritable and a production count confirmed the column stores none, so the
  // population the widening reached is empty — and matching a value nothing
  // stores only made the cloud disagree with desktop, which never widened. A
  // retired filter value now falls through to the exact-match fallback and
  // returns nothing, which is the honest answer for a spelling with no rows.
  if (status === SESSION_STATUS.INACTIVE) {
    return {
      artifact: {
        is: {
          status: SESSION_STATUS.INACTIVE,
        },
      },
    };
  }
  // ISS-4556: the terminal test is the projection's own —
  // `TERMINAL_SESSION_STATUSES.has(normalizeSessionStatus(status))`, byte-for-byte
  // what `projectDisplayedSessionStatus` asks before it projects Waiting — NOT a
  // bare membership check on the raw string. `TERMINAL_SESSION_STATUSES` holds
  // only the two CANONICAL terminals ({inactive, error}); the fold is what also
  // resolves the `failed` alias onto them. Testing the raw string called a
  // version-skewed row NON-terminal here while the projection called it
  // terminal, so the negation below applied to a row that never projects to
  // Waiting: filtering by that exact stored spelling returned ZERO rows while
  // the unfiltered list served the row and badged it as its terminal state. One
  // definition of "terminal", asked the same way on both sides.
  //
  // ISS-5592 left `failed` as the only alias this fold still catches: the
  // retired spellings no longer return from the Inactive branch above and reach
  // here unrecognized (thadeusb, #5075). The fold stays asked this way
  // regardless — it is the projection's own test, and a future alias must not
  // have to rediscover that.
  if (
    !displayedStatusParity ||
    TERMINAL_SESSION_STATUSES.has(normalizeSessionStatus(status))
  ) {
    return { artifact: { is: { status } } };
  }
  // ISS-4559: a NON-TERMINAL row that displays as Waiting belongs to the Waiting
  // facet and to no other, so it must not also come back under its raw status —
  // the same "matched by exactly the facet it displays" rule the Active branch
  // above encodes. Terminal statuses are excluded from this negation above: a
  // finished row holding a stale `awaitingInputSince` never projects to Waiting,
  // so subtracting it here would wrongly hide it from its own facet.
  return { ...DOES_NOT_DISPLAY_AS_WAITING, artifact: { is: { status } } };
}

/**
 * Apply the status facet at the session level, covering both the `statuses`
 * multi-select (its predicates OR together) and the single-value `status`
 * back-compat param. Kept separate from {@link applyArtifactFacetFilters}
 * because the Waiting/Active predicates reference `awaitingInputSince`, a
 * SessionDetail field rather than an `artifact` column.
 */
function applyStatusFacetFilter(
  where: Prisma.SessionDetailWhereInput,
  filters: AgentSessionUsageQuery | AgentSessionListQuery,
  displayedStatusParity: boolean
): void {
  let statuses: string[] = [];
  if (filters.statuses && filters.statuses.length > 0) {
    statuses = filters.statuses;
  } else if (filters.status) {
    statuses = [filters.status];
  }
  if (statuses.length === 0) {
    return;
  }
  const clause: Prisma.SessionDetailWhereInput =
    statuses.length === 1
      ? buildStatusFacetPredicate(statuses[0], displayedStatusParity)
      : {
          OR: statuses.map((status) =>
            buildStatusFacetPredicate(status, displayedStatusParity)
          ),
        };
  appendAndClauses(where, [clause]);
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
      // Sessions-list mismatch, FEA-2180). Pre-backfill rows have a null
      // lastActivityAt; fall back to sessionStartedAt for those, mirroring the
      // list projection (`record.lastActivityAt ?? record.sessionStartedAt`)
      // and the nulls-last ordering, so they aren't silently dropped.
      where.OR = [
        { lastActivityAt: range },
        { lastActivityAt: null, sessionStartedAt: range },
      ];
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
