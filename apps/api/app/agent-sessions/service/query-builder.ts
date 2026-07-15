import {
  autonomyTierRange,
  getSessionCostBucket,
} from "@repo/api/src/agent-session-filters";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { Prisma, withDb } from "@repo/database";
import {
  SESSION_STATUS,
  TERMINAL_SESSION_STATUSES,
} from "@closedloop-ai/loops-api/session-status";
import type {
  AgentSessionListQuery,
  AgentSessionUsageQuery,
} from "../validators";
import { isUuid } from "./coercion";
import { toAgentSessionState } from "./projections";
import {
  type AgentSessionScope,
  type SourceArtifactSummaryRecord,
  sourceArtifactSummarySelect,
} from "./records";

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
// two sources `toSessionPullRequestProjection` merges into `prs`, so the filter
// agrees with the PR pills the row shows.
const SESSION_HAS_PR_WHERE: Prisma.SessionDetailWhereInput = {
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

// PLN-1034: the Sessions list defaults to most-recent genuine activity. Nulls
// (pre-backfill rows) sort last; sessionStartedAt is the stable tiebreaker.
const SESSION_DEFAULT_ORDER_BY: Prisma.SessionDetailOrderByWithRelationInput[] =
  [
    { lastActivityAt: { sort: "desc", nulls: "last" } },
    { sessionStartedAt: "desc" },
    { createdAt: "desc" },
  ];

export function buildWhere(
  scope: AgentSessionScope,
  filters: AgentSessionUsageQuery | AgentSessionListQuery,
  // Which timestamp the date window filters on. Usage/analytics/export keep
  // `sessionStartedAt` (a session belongs to the period it started in). The
  // Sessions list opts into `lastActivityAt` so the window matches the field
  // the list is ordered by — see the `lastActivityAt` branch below.
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
  applyStatusFacetFilter(where, filters);
  applyDateFilter(where, filters, dateField);

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
  // Multi-select facets (statuses/userIds/repositories) take precedence over the
  // single-value back-compat params (e.g. the user-scoped deep link) when present.
  if (filters.userIds && filters.userIds.length > 0) {
    where.userId = { in: filters.userIds };
  } else if (filters.userId) {
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
  // The Model facet options come from the per-model token-usage breakdown
  // (`byModel` groups AgentSessionTokenUsage.model), so a session that used a
  // model only as a secondary/subagent model still shows under that option.
  // Match the same set via the token-usage relation rather than the single
  // primary `SessionDetail.model`, so selecting an option never returns fewer
  // rows than its count.
  if (filters.models && filters.models.length > 0) {
    where.tokenUsageByModel = { some: { model: { in: filters.models } } };
  }
  // Autonomy / cost / change / PR facets each OR their selected options; the OR
  // groups are ANDed together (and with the rest of the where) via `where.AND`,
  // which keeps them independent of the date filter's own `where.OR` clause.
  appendAndClauses(where, buildFacetAndClauses(filters));
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
 * OR the selected cost-bucket ranges into one clause. estimatedCost is a Decimal
 * column; Prisma accepts JS numbers for its comparators. Bucket bounds are the
 * SSOT in `@repo/api/src/agent-session-filters` (minCost inclusive, maxCost
 * exclusive; null maxCost = no upper bound).
 */
function buildCostBucketWhere(
  buckets: readonly string[] | undefined
): Prisma.SessionDetailWhereInput | null {
  if (!buckets || buckets.length === 0) {
    return null;
  }
  const clauses: Prisma.SessionDetailWhereInput[] = [];
  for (const bucketId of buckets) {
    const bucket = getSessionCostBucket(bucketId);
    if (!bucket) {
      continue;
    }
    clauses.push({
      estimatedCost: {
        gte: bucket.minCost,
        ...(bucket.maxCost === null ? {} : { lt: bucket.maxCost }),
      },
    });
  }
  return clauses.length > 0 ? { OR: clauses } : null;
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
    if (option === "has_changes") {
      clauses.push(SESSION_HAS_CHANGES_WHERE);
    } else if (option === "no_changes") {
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
    if (option === "has_pr") {
      clauses.push(SESSION_HAS_PR_WHERE);
    } else if (option === "no_pr") {
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
  // Status is NOT a plain `artifact.status` match: the Waiting and Active facets
  // derive from `awaitingInputSince` (a SessionDetail field), so the predicate
  // spans both tables and is built at the session level — see
  // {@link applyStatusFacetFilter}.
}

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
 *     set ({completed, error, abandoned}) is exactly the terminal set to exclude
 *     here.
 *   • `active` → `status = 'active'` AND not awaiting input (`awaitingInputSince`
 *     is null), so awaiting-input sessions are excluded as desktop excludes them.
 *   • anything else → a plain `artifact.status` equality.
 */
function buildStatusFacetPredicate(
  status: string
): Prisma.SessionDetailWhereInput {
  if (status === SESSION_STATUS.WAITING) {
    return {
      awaitingInputSince: { not: null },
      sessionEndedAt: null,
      artifact: { is: { status: { notIn: [...TERMINAL_SESSION_STATUSES] } } },
    };
  }
  if (status === SESSION_STATUS.ACTIVE) {
    return {
      awaitingInputSince: null,
      artifact: { is: { status: SESSION_STATUS.ACTIVE } },
    };
  }
  return { artifact: { is: { status } } };
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
  filters: AgentSessionUsageQuery | AgentSessionListQuery
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
      ? buildStatusFacetPredicate(statuses[0])
      : { OR: statuses.map(buildStatusFacetPredicate) };
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
 * Map a sort column + direction (from the table headers) to a Prisma `orderBy`.
 * Each sortable column falls back to recency as a stable tiebreaker; an unset
 * `sortBy` keeps the default updated-desc ordering.
 */
export function buildAgentSessionOrderBy(
  filters: AgentSessionListQuery
): Prisma.SessionDetailOrderByWithRelationInput[] {
  const dir = filters.sortDir ?? "desc";
  switch (filters.sortBy) {
    case "lastActivity":
      return [
        { lastActivityAt: { sort: dir, nulls: "last" } },
        { sessionStartedAt: "desc" },
      ];
    case "user":
      // The User model has no single `name` column; email is a stable, non-null
      // orderable proxy for the display name shown in the User column.
      return [{ user: { email: dir } }, { sessionUpdatedAt: "desc" }];
    case "status":
      return [{ artifact: { status: dir } }, { sessionUpdatedAt: "desc" }];
    case "repo":
      return [{ repositoryFullName: dir }, { sessionUpdatedAt: "desc" }];
    case "harness":
      return [{ harness: dir }, { sessionUpdatedAt: "desc" }];
    case "model":
      return [{ model: dir }, { sessionUpdatedAt: "desc" }];
    case "duration":
      // `wallClock` is a formatted string (e.g. "1h 5m"), so ordering by it
      // sorts lexicographically — wrong. There is no stored numeric duration
      // column to order by, so approximate with the session end time (the
      // closest sortable field), falling back to start time then recency.
      return [
        { sessionEndedAt: dir },
        { sessionStartedAt: dir },
        { sessionUpdatedAt: "desc" },
      ];
    case "cost":
      return [{ estimatedCost: dir }, { sessionUpdatedAt: "desc" }];
    case "started":
      return [{ sessionStartedAt: dir }, { createdAt: "desc" }];
    default:
      return SESSION_DEFAULT_ORDER_BY;
  }
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
