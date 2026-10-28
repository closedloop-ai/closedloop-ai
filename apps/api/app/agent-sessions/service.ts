import { resolveSessionQuality } from "@repo/api/src/agent-session-filters";
import type {
  AgentSessionAnalytics,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
  DesktopAgentSessionsPayload,
} from "@repo/api/src/types/agent-session";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { SESSION_LIST_MAX_LIMIT } from "@repo/api/src/types/agent-session-list-limits";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { ArtifactSessionUsageSummary } from "@repo/api/src/types/session-artifact-link";
import { sessionStatusRootRankOrNull } from "@repo/api/src/types/session-status-root-order";
import { withDb } from "@repo/database";
// The leaf module, NOT the `@repo/database` barrel: ~20 suites already
// `vi.mock("@repo/database")`, and their mocks carry `withDb` alone. Same reason
// `lib/db-fanout.ts` imports these two from here.
import {
  createDbAcquisitionBudget,
  withDbAcquisitionBudget,
} from "@repo/database/acquisition-budget";
import {
  aggregateArtifactUsageByTargetShare,
  aggregateSessionAttributionLenses,
} from "@/lib/agent-session-attribution";
import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import { isFeatureFlagEnabledForAnyIdentity } from "@/lib/feature-flag-identity";
import { ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { toNumber } from "@/lib/prisma-number";
import {
  aggregateByAgentType,
  aggregateByProject,
  aggregateByTool,
  aggregateFullArtifactSessionUsageByModel,
  fetchAnalyticsRepositoryBreakdown,
} from "./service/analytics-aggregation";
import {
  readAnalyticsProjectsByArtifactId,
  readAnalyticsSessions,
} from "./service/analytics-read";
import { withoutAttributionEvidence } from "./service/attribution/attribution-evidence-payload";
import { findAgentSessionExportRows } from "./service/export-rows";
import { listSessionsByArtifactIds } from "./service/list-by-artifact-ids";
import { loadListCommentCounts } from "./service/list-comment-counts";
import { loadListCustomFieldValues } from "./service/list-custom-field-values";
import { resolveSessionListPage } from "./service/list-page-fetch";
import { loadListTranscriptVerdicts } from "./service/list-transcript-dispositions";
import type { SessionsPenseroPointsReader } from "./service/pensero-points-per-dollar";
import { toViewerScope } from "./service/project-resolution";
import { toSessionListItem } from "./service/projections";
import {
  buildAgentSessionOrderBy,
  buildIdleCountWhere,
  buildWhere,
  findSourceArtifactsById,
} from "./service/query-builder";
import type {
  SessionListInput,
  SessionUsageInput,
  UpsertSessionsContext,
} from "./service/records";
import {
  listRelatedSessions,
  listRelatedSessionsForArtifacts,
} from "./service/related-sessions";
import { SESSIONS_SURFACE_DATE_FIELD } from "./service/session-date-field";
import { findAgentSessionDetail } from "./service/session-detail-read";
import { readAgentSessionEventsPage } from "./service/session-events-page-read";
import {
  requiresInMemorySessionSort,
  resolveSessionSortRules,
} from "./service/session-sort-rules";
import {
  readSessionTokenEvents,
  readSessionUsageRollup,
} from "./service/session-usage-reads";
import {
  type UpsertSessionsBatchOptions,
  upsertSessionsBatch,
} from "./service/upsert-sessions-batch";
import { buildUsageSummary } from "./service/usage-summary";
import { buildUsageSummaryWhere } from "./service/usage-summary-where";
import { sessionTranscriptGroupKey } from "./transcript-availability";

const SESSION_LIST_DEFAULT_LIMIT = 25;
export const agentSessionsService = {
  /**
   * Goal stage 2 (atomic row-level ack): resolves to the `externalSessionId`s
   * this call actually PERSISTED, so the desktop's outbox clear can be keyed on
   * server truth rather than on what the client sent. `upsertSessionSlice`
   * reports `persisted: false` for a slice it deliberately did not write (a
   * foreign chunk — one whose revision does not match the server's pending
   * assembly), and such an id must NOT appear in the ack echo: echoing it would
   * let the desktop clear a row the server never stored, which is silent loss.
   *
   * FEA-1718: the ingest batch moved to `service/upsert-sessions-batch.ts` — it
   * owns the per-session transaction sequencing. The method stays here because
   * the route and its tests address the service object (same split as
   * `buildUsageSummary`).
   */
  upsertSessions(
    context: UpsertSessionsContext,
    payload: DesktopAgentSessionsPayload,
    recordSessionWrite?: UpsertSessionsBatchOptions["recordSessionWrite"]
  ): Promise<{ persistedSessionIds: string[] }> {
    // FEA-1718: the ingest batch moved to `service/upsert-sessions-batch.ts` —
    // it owns the per-session transaction sequencing and the batch-level
    // retired-status fold tally (ISS-5648). The method stays here because the
    // route and its tests address the service object (same split as
    // `buildUsageSummary`).
    //
    // ISS-12552 (PRD-800 "Rollout"): the sync caller's organization is
    // read once, before any slice transaction opens. Off, the batch sees the
    // payload as it was before PRD-800 and the request scope gives the
    // post-commit derivation the same answer.
    return runWithAttributionEvidenceGate(async () => {
      const captured = (await isAttributionEvidenceEnabledForOrganization(
        context.organizationId
      ))
        ? payload
        : withoutAttributionEvidence(payload);
      return await upsertSessionsBatch(context, captured, {
        recordSessionWrite,
      });
    });
  },

  async getUsageSummary(
    input: SessionUsageInput,
    /** ISS-11117. See {@link buildUsageSummary}. */
    readPenseroPointsPerDollar?: SessionsPenseroPointsReader
  ): Promise<AgentSessionUsageSummary> {
    // ISS-5809: the composition moved to `service/usage-summary.ts` — it owns
    // WHICH population each aggregate runs over plus the prior-period
    // comparison. The method stays here because the route and its tests address
    // the service object.
    return await buildUsageSummary(input, readPenseroPointsPerDollar);
  },

  findExportRows: findAgentSessionExportRows,

  async findSessions(
    input: SessionListInput
  ): Promise<AgentSessionListResponse> {
    const limit = Math.min(
      input.filters.limit ?? SESSION_LIST_DEFAULT_LIMIT,
      SESSION_LIST_MAX_LIMIT
    );
    const offset = input.filters.offset ?? 0;
    // ISS-7176: `costBuckets` goes into the DB `where` like every other facet.
    // It used to be STRIPPED here so the bucket could be re-applied in memory on
    // a reconciled value — which meant a row was bucketed by one number and
    // displayed as another. Now both are `session_detail.estimated_cost`, so
    // `buildCostBucketWhere` is simply the filter and the page needs no candidate
    // scan, no in-memory re-bucketing, and no 10,000-session cap.
    const whereFilters = input.filters;
    // Window on the shared `SESSIONS_SURFACE_DATE_FIELD` (lastActivityAt) — the
    // field the list orders by, and the SAME constant `getUsageSummary` windows
    // on, so table and cards stay one cohort for a date range (FEA-2180/FEA-4298).
    const where = await buildWhere(
      input,
      whereFilters,
      SESSIONS_SURFACE_DATE_FIELD
    );
    // FEA-4297/FEA-4300: Duration and Owner sort by a DERIVED display value with
    // no single trustworthy DB column, so — like the cost-reconcile path — they
    // fetch a bounded candidate set and order/paginate in memory against the
    // exact rendered value (`findDisplayValueSortedPage`).
    //
    // ISS-8335: asked of the whole RULE LIST, not of its first entry. One
    // display-value rule anywhere takes the query in-memory, because a chain the
    // database can order only part of is a chain it orders wrongly — it would
    // paginate by the primary and settle every tie on `artifactId`, leaving the
    // toolbar's later rules with nothing to decide.
    const sortRules = resolveSessionSortRules(input.filters);
    // D5: read the existing rollout once, before entering the list snapshot.
    // The off path retains its indexed persisted-string ORDER BY.
    const statusRootRank =
      input.viewerId &&
      sortRules.some((rule) => rule.column === "status") &&
      (await isFeatureFlagEnabledForAnyIdentity(
        ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG,
        { userId: input.viewerId, clerkUserId: input.clerkUserId },
        "sessions.status-ordering.flag-evaluation-failed"
      ))
        ? sessionStatusRootRankOrNull
        : undefined;
    const displayValueSorted =
      requiresInMemorySessionSort(sortRules) || statusRootRank !== undefined;
    const orderBy = buildAgentSessionOrderBy(input.filters);
    // FEA-3284/FEA-3345: count idle rows hidden by a `substantive` view (scoped to
    // every OTHER filter so the reveal label is accurate) ONLY when the effective
    // quality — resolved through the SAME `DEFAULT_SESSION_QUALITY` seam
    // `applyQualityFilter` uses so the two can't desync — is `substantive`; `all`
    // hides nothing, so we skip the extra count.
    const effectiveQuality = resolveSessionQuality(input.filters.quality);
    const idleWhere =
      effectiveQuality === "substantive"
        ? await buildIdleCountWhere(
            input,
            whereFilters,
            SESSIONS_SURFACE_DATE_FIELD
          )
        : null;

    // Dispatch to the display-value or DB-paginated path (see
    // `resolveSessionListPage`); duration/owner order by a derived value and
    // resolve in memory (FEA-4297/4300). Cost is DB-native now (ISS-7176) —
    // `estimatedCost` is the value, so it orders like any other column.
    const { items, total, idleCount } = await resolveSessionListPage({
      displayValueSorted,
      statusRootRank,
      organizationId: input.organizationId,
      where,
      idleWhere,
      orderBy,
      offset,
      limit,
      filters: input.filters,
    });
    const sourceArtifactsById = await findSourceArtifactsById(
      input.organizationId,
      items.map((item) => item.sourceArtifactId)
    );
    // PRD-536 G1 (Phase 3): batch the per-session transcript verdict for the
    // page in ONE query so each list row can render the same freshness
    // affordance the detail Properties panel does (`getSessionSyncStatus`),
    // without a per-row detail fetch. Grouped + folded by the SAME
    // `deriveTranscriptDisposition` the detail path uses (SSOT).
    const transcriptVerdictByKey = await loadListTranscriptVerdicts(
      input.organizationId,
      items.map((item) => ({
        computeTargetId: item.computeTarget.id,
        externalSessionId: item.externalSessionId,
      }))
    );
    // FEA-4204: one grouped query for the page's comment thread counts,
    // batched exactly like the two reads above. A per-row count here would be an
    // N+1 on the most-loaded read in the product. Scoped-failure-tolerant by
    // contract: this read owns its own failure and degrades to an EMPTY map, so
    // a read that falls over omits `commentCount` on every row (the client
    // renders no tag) instead of rejecting an otherwise-complete Sessions list.
    const sessionIds = items.map((item) => item.artifactId);
    const [commentCountByArtifactId, customFieldValuesBySessionId] =
      await Promise.all([
        loadListCommentCounts(input.organizationId, sessionIds),
        loadListCustomFieldValues(input.organizationId, sessionIds),
      ]);

    return {
      items: items.map((item) =>
        toSessionListItem(
          item,
          sourceArtifactsById,
          transcriptVerdictByKey.get(
            sessionTranscriptGroupKey({
              computeTargetId: item.computeTarget.id,
              externalSessionId: item.externalSessionId,
            })
          ),
          commentCountByArtifactId.get(item.artifactId),
          customFieldValuesBySessionId === null
            ? undefined
            : (customFieldValuesBySessionId.get(item.artifactId) ?? []),
          // ISS-8712: tags are joined on this page's own SELECT, so there is no
          // batched map to look up — only the org and the caller's capabilities
          // the projection needs to scope and describe them.
          input.tagPermissions === undefined
            ? undefined
            : {
                organizationId: input.organizationId,
                permissions: input.tagPermissions,
              }
        )
      ),
      total,
      idleCount,
      viewerScope: toViewerScope(input.filters),
      // ISS-9555: which page this read served. The rows above came FROM
      // `offset` at `limit`, so a consumer reads the position off this instead
      // of re-deriving it from its own request and `total`. This read never
      // moves an out-of-range request onto another page, so an offset past the
      // population still answers empty and still echoes that offset.
      pageInfo: {
        capability: AgentSessionListCapability.ServerPaginationV1,
        limit,
        offset,
      },
    };
  },

  /**
   * Fetch org-scoped session list-item summaries for a set of Session artifact
   * ids, in the same wire shape the Sessions page consumes. Owned by
   * `service/list-by-artifact-ids.ts`, including its optional ISS-5464 payload
   * bound; referenced directly rather than re-wrapped, so the signature cannot
   * drift from the implementation it exposes.
   */
  listByArtifactIds: listSessionsByArtifactIds,

  /**
   * ISS-7234: sessions that contributed to or commented on an artifact.
   * Referenced directly for the same reason as `listByArtifactIds` above.
   */
  listRelatedSessions,

  /**
   * ISS-9570: page-shaped sibling of `listRelatedSessions`, keyed by artifact
   * id so grid consumers can resolve a page without per-row reads.
   */
  listRelatedSessionsForArtifacts,

  /**
   * ISS-9112: the read itself is owned by `service/session-detail-read.ts`,
   * which resolves a SET of ids in a fixed number of queries. Referenced
   * through this wrapper so the exported service keeps its `(input, options)`
   * signature for the many callers that ask for exactly one session.
   */
  findSessionDetail: findAgentSessionDetail,

  /**
   * ISS-9857: the keyset page past the detail's bounded event prefix. Same org
   * boundary as `findSessionDetail`; `null` is a session the caller may not see.
   */
  findSessionEventsPage: readAgentSessionEventsPage,

  async getAnalytics(input: SessionUsageInput): Promise<AgentSessionAnalytics> {
    // thread whitlockk (ISS-4481): route the analytics read through the SAME
    // reconciled cost cohort the list/usage/export paths use, instead of
    // `buildWhere(input, input.filters)` which would run `buildCostBucketWhere`'s
    // Unknown / numeric clauses against the STALE `estimatedCost` rollup. A
    // legacy row whose rollup is 0 but whose reconciled per-event cost is $0.42
    // renders a `$` figure (not Unknown) everywhere else, so a rollup-keyed
    // analytics filter would disagree with the list/usage/export. Analytics uses
    // the Sessions surface activity window; `buildUsageSummaryWhere` strips `costBuckets`, resolves the
    // reconciled-matched id set, and ANDs it onto the base where — a no-op read
    // for a non-cost-sensitive query.
    const where = await buildUsageSummaryWhere(
      input,
      SESSIONS_SURFACE_DATE_FIELD
    );
    // ISS-9113: these four reads are mutually independent — none consumes
    // another's rows — and each opens its own `withDb`, so unlike the list paths
    // there is no single-connection reason to serialize them. They shared one
    // sequential chain, which spent four round trips of latency to produce four
    // answers that never referred to each other. The shared limiter is the
    // `getUsageSummary` pattern: bounds compose by addition, so sibling reads
    // that run concurrently within one request must draw on ONE budget.
    //
    // thread whitlockk (ISS-8431): the limiter bounds CALLS, and calls are not
    // connections. `readAnalyticsSessions` selects the `events` relation and the
    // attribution read selects its own, so Prisma runs those as parallel child
    // queries that each take a connection in the same tick — and each `withDb`
    // below would otherwise open a FRESH acquisition ceiling, letting four
    // siblings stack to `4 x DB_ACQUISITION_BUDGET_MAX` and blow through the
    // half-pool budget the fan-out is supposed to respect. ONE budget for the
    // whole group, which the inner `withDb` calls join instead of opening their
    // own.
    const limiter = createDbFanoutLimiter();
    const [byRepository, sessions, projectsByArtifactId, attributionLenses] =
      await withDbAcquisitionBudget(
        async () =>
          await Promise.all([
            limiter(() => fetchAnalyticsRepositoryBreakdown(where)),
            readAnalyticsSessions(where, limiter),
            readAnalyticsProjectsByArtifactId(where, limiter),
            aggregateSessionAttributionLenses(
              input.organizationId,
              where,
              limiter
            ),
          ]),
        createDbAcquisitionBudget()
      );

    const byTool = aggregateByTool(sessions);
    const { byAgentType, integrity: agentRosterIntegrity } =
      aggregateByAgentType(sessions);
    const byProject = aggregateByProject(sessions, projectsByArtifactId);

    return {
      viewerScope: toViewerScope(input.filters),
      byTool,
      byAgentType,
      // Spread-shaped, so a whole population leaves `agentRosterIncomplete`
      // genuinely OMITTED rather than serialized as a present falsy value.
      ...agentRosterIntegrity,
      byRepository,
      byProject,
      ...(attributionLenses.byBranch.length > 0
        ? { byBranch: attributionLenses.byBranch }
        : {}),
      ...(attributionLenses.byPr.length > 0
        ? { byPr: attributionLenses.byPr }
        : {}),
    };
  },

  /**
   * FEA-1684 Task 8: Cloud attribution query — returns aggregate token usage
   * for all sessions linked to a given artifact via ArtifactLink edges.
   */
  async getArtifactSessionUsage(
    organizationId: string,
    artifactId: string
  ): Promise<ArtifactSessionUsageSummary | null> {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: { id: artifactId, organizationId },
        select: {
          id: true,
          slug: true,
          branch: { select: { artifactId: true } },
        },
      })
    );
    if (!artifact) {
      return null;
    }

    // Find all ArtifactLink edges where this artifact is the target and the
    // source is a SESSION artifact (linkType = RELATES_TO).
    const links = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          targetId: artifactId,
          linkType: LinkType.RelatesTo,
          source: { type: ArtifactType.Session, organizationId },
        },
        select: { sourceId: true },
      })
    );

    const sessionArtifactIds = [...new Set(links.map((link) => link.sourceId))];
    if (sessionArtifactIds.length === 0) {
      return {
        artifactId: artifact.id,
        artifactSlug: artifact.slug,
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        byModel: [],
      };
    }

    if (artifact.branch) {
      return aggregateArtifactUsageByTargetShare({
        artifactId: artifact.id,
        artifactSlug: artifact.slug,
        organizationId,
        sessionArtifactIds,
        targetArtifactId: artifact.id,
      });
    }

    const [aggregate, byModelGroup] =
      await aggregateFullArtifactSessionUsageByModel({
        organizationId,
        sessionArtifactIds,
      });

    return {
      artifactId: artifact.id,
      artifactSlug: artifact.slug,
      sessionCount: aggregate._count._all,
      inputTokens: toNumber(aggregate._sum.inputTokens),
      outputTokens: toNumber(aggregate._sum.outputTokens),
      cacheReadTokens: toNumber(aggregate._sum.cacheReadTokens),
      cacheWriteTokens: toNumber(aggregate._sum.cacheWriteTokens),
      estimatedCostUsd: toNumber(aggregate._sum.estimatedCost),
      byModel: byModelGroup
        .map((group) => ({
          model: group.model,
          inputTokens: toNumber(group._sum.inputTokens),
          outputTokens: toNumber(group._sum.outputTokens),
          cacheReadTokens: toNumber(group._sum.cacheReadTokens),
          cacheWriteTokens: toNumber(group._sum.cacheWriteTokens),
          estimatedCostUsd: toNumber(group._sum.estimatedCost),
        }))
        .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd),
    };
  },

  getSessionTokenEvents: readSessionTokenEvents,

  getSessionAnalytics: readSessionUsageRollup,
};
