import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/api/src/agent-session-detail-projection";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionRepositoryBreakdown,
  AgentSessionUsageByModel,
  AgentSessionUsageByUser,
  AgentSessionUsageSummary,
  DesktopAgentSessionsPayload,
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { ArtifactSessionUsageSummary } from "@repo/api/src/types/session-artifact-link";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { Prisma, withDb } from "@repo/database";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import {
  aggregateArtifactUsageByTargetShare,
  aggregateSessionAttributionLenses,
} from "@/lib/agent-session-attribution";
import { computeAgentSessionDeliveryMetrics } from "@/lib/agent-session-delivery-metrics";
import type { DispatchAwaitingInputNotificationParams } from "@/lib/awaiting-input-notifications";
import { isAwaitingInputTransition } from "@/lib/awaiting-input-transition";
import { basicUserSelect } from "@/lib/db-utils";
import {
  sessionTraceCorrectionSourceSchema,
  sessionTracePhaseSourceSchema,
  sessionTraceThrottleSourceSchema,
} from "@/lib/desktop-agent-sessions-schema";
import { isOrgScopeOwned, resolveOrgScopeVia } from "@/lib/org-scope";
import { generateSlug } from "@/lib/slug-generator";
import {
  aggregateByAgentType,
  aggregateByProject,
  aggregateByRepository,
  aggregateByTool,
  aggregateFullArtifactSessionUsageByModel,
} from "./service/analytics-aggregation";
import { persistSessionBranchArtifactLinks } from "./service/artifact-links/branch-links";
import { persistSessionCommitRefs } from "./service/artifact-links/commit-links";
import { persistSessionPrArtifactLinks } from "./service/artifact-links/pr-links";
import { persistSessionPullRequestDetails } from "./service/artifact-links/pull-request-details";
import { resolveBranchRepoMap } from "./service/artifact-links/shared";
import {
  persistArtifactLinks,
  resolveArtifactSlugMap,
} from "./service/artifact-links/slug-links";
import {
  decimalToNumber,
  isUuid,
  mergeJsonArrayByKey,
  normalizeNullableString,
  parseJsonArray,
  roundCost,
  toDate,
  tokenCountToNumber,
  toMetadata,
} from "./service/coercion";
import { persistSessionComponentUsage } from "./service/component-usage";
import {
  type AgentSessionCsvExportRow,
  toCsvExportRows,
} from "./service/csv-export";
import {
  persistSessionChildren,
  toAttributionColumns,
  toNonNullAttributionPatch,
  toTraceDetailPatch,
} from "./service/persist-session-children";
import {
  resolveProjectId,
  resolveProjectResolution,
  toLastSyncTarget,
  toViewerScope,
} from "./service/project-resolution";
import {
  buildUserColor,
  DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
  displayUserName,
  toBasicUser,
  toSessionListItem,
} from "./service/projections";
import {
  ANALYTICS_QUERY_BATCH_SIZE,
  buildAgentSessionOrderBy,
  buildLastSyncTargetWhere,
  buildWhere,
  findPagedRecords,
  findSourceArtifactsById,
} from "./service/query-builder";
import {
  type AnalyticsJsonSessionRecord,
  type AnalyticsScalarSessionRecord,
  agentSessionDetailSelect,
  agentSessionExportSelect,
  agentSessionListSelect,
  analyticsJsonSelect,
  analyticsScalarSelect,
  type SessionDetailInput,
  type SessionListInput,
  type SessionUsageInput,
  type UpsertSessionsContext,
} from "./service/records";
import {
  getLoopApiKeySource,
  isSubscriptionBillingMode,
  normalizeTokenUsage,
  sumTokenUsage,
  toAttribution,
  toSyncedAgents,
  toTokenUsageBreakdown,
} from "./service/synced-payload";
import {
  hasMainTranscript,
  missingMainSummary,
  sessionTranscriptIdentityWhere,
  toTranscriptAvailabilitySummary,
} from "./transcript-availability";

const SESSION_LIST_DEFAULT_LIMIT = 25;
const SESSION_LIST_MAX_LIMIT = 100;
// Keyset-pagination page size for the CSV export stream (findExportRows), which
// aggregates rows incrementally so a large export never materializes every
// matching sessionDetail row in memory at once.
const EXPORT_BATCH_SIZE = 1000;
// Defensive ceiling for the keep-all, unretained per-event token stream: a
// single pathological session must not load an unbounded number of rows into
// memory. The focus pages read bounded date windows well under this; the cap is
// a safety limit, not a functional page size.
const SESSION_TOKEN_EVENT_MAX_ROWS = 10_000;

/**
 * FEA-2730 (G1): read view for one raw per-event token row. Token counts and
 * cost are narrowed from BigInt/Decimal to JS numbers within the 2^53 envelope,
 * matching the other cloud read paths.
 */
type AgentSessionTokenEventView = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  eventCreatedAt: Date;
};

/** FEA-2730 (G10): read view for the per-session usage rollup. */
type AgentSessionUsageRollupView = {
  startedAt: Date | null;
  startedDay: string | null;
  status: string | null;
  harness: string | null;
  isHuman: boolean;
  humanTurns: number;
  agentTurns: number;
  eventCount: number;
  toolInvocations: number;
  errorEvents: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  runtimeMs: number | null;
  rollupUpdatedAt: Date | null;
};

export const agentSessionsService = {
  async upsertSessions(
    context: UpsertSessionsContext,
    payload: DesktopAgentSessionsPayload
  ): Promise<void> {
    const syncTimestamp = new Date();

    // FEA-2858: runs that just flipped into awaiting-input during this sync.
    // Collected inside the transaction, dispatched only after it commits so a
    // rolled-back sync never pushes a phantom "needs input" notification.
    const awaitingInputTransitions: DispatchAwaitingInputNotificationParams[] =
      [];

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: revision-gating adds inherent branching per FEA-1787
    await withDb.tx(async (tx) => {
      const target = await tx.computeTarget.findFirst({
        where: {
          id: context.computeTargetId,
          organizationId: context.organizationId,
        },
        select: {
          id: true,
        },
      });
      if (!target) {
        throw new Error("compute_target_not_found");
      }

      const projectResolution = await resolveProjectResolution(
        tx,
        context.organizationId,
        payload.sessions
      );

      // FEA-1684: batch-resolve artifact slugs referenced across all sessions
      // so per-session ArtifactLink creation uses a single round-trip.
      const slugMap = await resolveArtifactSlugMap(
        tx,
        context.organizationId,
        payload.sessions
      );

      // FEA-2729: batch-resolve the branch-ref repo map once for the whole
      // payload (org installation + repos are invariant across sessions), so
      // the per-session branch lane avoids the N+1 org/repo lookup.
      const branchRepoIdByFullName = await resolveBranchRepoMap(
        tx,
        context.organizationId,
        payload.sessions
      );

      for (const session of payload.sessions) {
        const normalizedTokenUsage = normalizeTokenUsage(
          session.tokenUsageByModel
        );
        const tokenTotals = sumTokenUsage(normalizedTokenUsage);
        const projectId = resolveProjectId(session, projectResolution);
        const attributionColumns = toAttributionColumns(session);
        // The parent artifact requires a non-null display name; fall back to a
        // stable label derived from the external session id (mirrors backfill).
        const sessionName =
          normalizeNullableString(session.name) ??
          `Session ${session.externalSessionId}`;

        // Merge agents with any existing record so chunked batches
        // accumulate rather than overwrite. Existence also drives create-vs-
        // update (a new session needs a parent artifact + SES-* slug).
        // Advisory lock scoped to this transaction prevents concurrent syncs
        // for the same session from both reading stale dataRevision and
        // double-deleting events (TOCTOU race).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${session.externalSessionId}))`;

        const existing = await tx.sessionDetail.findUnique({
          where: {
            computeTargetId_externalSessionId: {
              computeTargetId: context.computeTargetId,
              externalSessionId: session.externalSessionId,
            },
          },
          select: {
            artifactId: true,
            agents: true,
            dataRevision: true,
            // FEA-2858: prior awaiting-input state, to detect the null →
            // non-null transition that fires the "run needs input" notification.
            awaitingInputSince: true,
          },
        });

        const shouldReplace =
          session.dataRevision != null &&
          session.dataRevision !== existing?.dataRevision;

        const mergedAgents = shouldReplace
          ? session.agents
          : mergeJsonArrayByKey(
              existing?.agents,
              session.agents,
              "externalAgentId"
            );

        // Shared mutable detail-table columns, written on both create + update.
        // Attribution-derived columns are NOT here: updates must not clear
        // them when a payload omits attribution (see the spreads below).
        const detailData = {
          harness: normalizeNullableString(session.harness) ?? "unknown",
          cwd: normalizeNullableString(session.cwd),
          model: normalizeNullableString(session.model),
          // FEA-1459: deviceTimeZone is optional on the wire (older Desktop
          // builds omit it). Only write the column when the field is present —
          // an omission must never null-out a zone a newer client already
          // synced, or CSV exports would silently fall back to UTC.
          ...(session.deviceTimeZone === undefined
            ? {}
            : {
                deviceTimeZone: normalizeNullableString(session.deviceTimeZone),
              }),
          ...(session.dataRevision == null
            ? {}
            : { dataRevision: session.dataRevision }),
          sessionStartedAt: new Date(session.startedAt),
          sessionUpdatedAt: new Date(session.updatedAt),
          sessionEndedAt: toDate(session.endedAt),
          awaitingInputSince: toDate(session.awaitingInputSince),
          inputTokens: tokenTotals.inputTokens,
          outputTokens: tokenTotals.outputTokens,
          cacheReadTokens: tokenTotals.cacheReadTokens,
          cacheWriteTokens: tokenTotals.cacheWriteTokens,
          estimatedCost: roundCost(tokenTotals.estimatedCost),
          agentCount: mergedAgents.length,
          metadata: session.metadata ?? Prisma.DbNull,
          agents: mergedAgents,
          lastSyncedAt: syncTimestamp,
          ...toTraceDetailPatch(session),
        };

        // Allocate the SES-* slug only when creating the parent artifact.
        // generateSlug's withDb call joins this ambient transaction via
        // AsyncLocalStorage, so allocation stays atomic with the create.
        const slug = existing
          ? undefined
          : await generateSlug(context.organizationId, SlugPrefix.Session);

        const persisted = await tx.sessionDetail.upsert({
          where: {
            computeTargetId_externalSessionId: {
              computeTargetId: context.computeTargetId,
              externalSessionId: session.externalSessionId,
            },
          },
          create: {
            artifact: {
              create: {
                organization: { connect: { id: context.organizationId } },
                ...(projectId
                  ? { project: { connect: { id: projectId } } }
                  : {}),
                type: ArtifactType.Session,
                name: sessionName,
                status: session.status,
                slug,
                createdBy: { connect: { id: context.userId } },
              },
            },
            user: { connect: { id: context.userId } },
            computeTarget: { connect: { id: context.computeTargetId } },
            externalSessionId: session.externalSessionId,
            toolUseCount: 0,
            errorCount: 0,
            ...detailData,
            ...attributionColumns,
          },
          update: {
            artifact: {
              update: {
                name: sessionName,
                status: session.status,
                // Attribution is optional on the wire (older Desktop builds,
                // chunked/partial payloads). Only (re)connect when a project
                // resolves — never disconnect on a missing signal, or version
                // skew would silently unparent previously attributed sessions.
                ...(projectId
                  ? { project: { connect: { id: projectId } } }
                  : {}),
              },
            },
            ...detailData,
            // Same rule as the project connect above: write only the non-null
            // attribution values so an attribution-less resync never clears
            // previously captured attribution.
            ...toNonNullAttributionPatch(attributionColumns),
          },
          select: {
            artifactId: true,
          },
        });

        // FEA-2858: a run that just blocked on the user (null → non-null
        // awaitingInputSince, and not already ended) queues a "needs input"
        // notification, dispatched after the transaction commits.
        if (
          isAwaitingInputTransition(
            existing?.awaitingInputSince ?? null,
            detailData.awaitingInputSince,
            detailData.sessionEndedAt,
            session.status
          )
        ) {
          awaitingInputTransitions.push({
            userId: context.userId,
            organizationId: context.organizationId,
            sessionId: persisted.artifactId,
            sessionName,
          });
        }

        await persistSessionChildren(
          tx,
          persisted.artifactId,
          session,
          normalizedTokenUsage,
          shouldReplace
        );

        // FEA-1684: create ArtifactLink edges from this session to referenced
        // Closedloop artifacts (documents, features, plans, etc.).
        await persistArtifactLinks(
          tx,
          context.organizationId,
          persisted.artifactId,
          session.artifactRefs,
          slugMap
        );

        await persistSessionPrArtifactLinks(
          tx,
          context.organizationId,
          persisted.artifactId,
          session.prRefs
        );

        // FEA-2729 + PLN-1099 Phase 1: persist SESSION→BRANCH links from
        // branch-kind refs, artifact-first CREATING the branch row when absent
        // (all captured branches sync — un-pushed and non-App included). Runs
        // AFTER the PR lane so it can merge branch evidence onto a link the PR
        // lane may share (same source/target/RELATES_TO row) without loss.
        await persistSessionBranchArtifactLinks(
          tx,
          context.organizationId,
          projectId,
          persisted.artifactId,
          session.artifactRefs,
          branchRepoIdByFullName
        );

        // FEA-2732: sync the session's PR facts into PullRequestDetail. Runs
        // AFTER the branch lane so the PR's HEAD-branch artifact is resolved (or
        // D2-created) first — artifact-first, PRD-510 FR13. Reuses the branch
        // lane's org-scoped installation-repo map for App-repo enrichment.
        await persistSessionPullRequestDetails(
          tx,
          context.organizationId,
          projectId,
          persisted.artifactId,
          session.artifactRefs,
          branchRepoIdByFullName
        );

        // FEA-2731 / PRD-510 D7: upsert CommitDetail rows from commit-kind refs.
        // Runs AFTER the branch lane so a branch created from this session's own
        // branch refs is already resolvable; a commit whose branch is still
        // absent is deferred (never orphaned).
        await persistSessionCommitRefs(
          tx,
          context.organizationId,
          persisted.artifactId,
          session.artifactRefs
        );

        // T-7.6 / AC-011: persist per-session component usage rows. Omission
        // (older desktop builds) leaves previously persisted rows untouched.
        await persistSessionComponentUsage(
          tx,
          context.computeTargetId,
          persisted.artifactId,
          session
        );
      }

      await tx.computeTarget.update({
        where: {
          id: context.computeTargetId,
        },
        data: {
          lastAgentSessionSyncAt: syncTimestamp,
        },
      });
    });

    // FEA-2858: fire "run needs input" notifications only after the sync commits
    // (each dispatch is itself flag-gated, fire-and-forget, and fail-soft).
    // Lazily import the notifier so this module's transitive `server-only`
    // dependency (Liveblocks inbox) is not loaded during the tsx gateway
    // import-smoke check, which runs outside Next.js.
    if (awaitingInputTransitions.length > 0) {
      const { dispatchAwaitingInputNotification } = await import(
        "@/lib/awaiting-input-notifications"
      );
      for (const transition of awaitingInputTransitions) {
        dispatchAwaitingInputNotification(transition);
      }
    }
  },

  async getUsageSummary(
    input: SessionUsageInput
  ): Promise<AgentSessionUsageSummary> {
    const startedAtMs = Date.now();
    const where = buildWhere(input, input.filters);
    const [summaryRows, attributionLenses] = await Promise.all([
      withDb(async (db) =>
        Promise.all([
          db.sessionDetail.aggregate({
            where,
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
            _min: {
              sessionStartedAt: true,
            },
            _max: {
              sessionStartedAt: true,
            },
          }),
          db.sessionDetail.groupBy({
            by: ["userId"],
            where,
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
          }),
          db.agentSessionTokenUsage.groupBy({
            by: ["model"],
            where: {
              session: {
                is: where,
              },
            },
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
          }),
          db.sessionDetail.groupBy({
            by: ["harness"],
            where,
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
          }),
          db.sessionDetail.groupBy({
            by: ["repositoryFullName"],
            where,
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              estimatedCost: true,
              errorCount: true,
            },
          }),
          // Cost split. Aggregate estimatedCost in the DB grouped by both
          // sourceLoopId and billingMode, instead of materializing one row per
          // session and summing in JS. Loop-originated rows are classified by the
          // linked loop's apiKeySource; DESKTOP_SYNC rows (no source Loop) are
          // classified by their synced billingMode. Classification below.
          db.sessionDetail.groupBy({
            by: ["sourceLoopId", "billingMode"],
            where,
            _sum: {
              estimatedCost: true,
            },
          }),
          db.computeTarget.findMany({
            where: buildLastSyncTargetWhere(input, input.filters),
            select: {
              id: true,
              machineName: true,
              isOnline: true,
              lastSeenAt: true,
              lastAgentSessionSyncAt: true,
              user: {
                select: basicUserSelect.select,
              },
            },
            orderBy: [
              {
                lastAgentSessionSyncAt: "desc",
              },
              {
                lastSeenAt: "desc",
              },
            ],
            take: 20,
          }),
        ])
      ),
      aggregateSessionAttributionLenses(where),
    ]);
    const [
      aggregate,
      byUserGroup,
      byModelGroup,
      byHarnessGroup,
      byRepositoryGroup,
      costsByLoop,
      lastSyncTargets,
    ] = summaryRows;
    const sourceLoopIds = [
      ...new Set(costsByLoop.map((row) => row.sourceLoopId)),
    ].filter((value): value is string => value != null);
    const loopApiKeySourceById = sourceLoopIds.length
      ? new Map(
          (
            await withDb((db) =>
              db.loop.findMany({
                where: {
                  organizationId: input.organizationId,
                  id: {
                    in: sourceLoopIds,
                  },
                },
                select: {
                  id: true,
                  metadata: true,
                },
              })
            )
          ).map((loop) => [loop.id, getLoopApiKeySource(loop.metadata)])
        )
      : new Map<string, string | null>();
    let subscriptionEstimatedCost = 0;
    let apiEstimatedCost = 0;

    for (const row of costsByLoop) {
      const estimatedCost = decimalToNumber(row._sum.estimatedCost);

      if (row.sourceLoopId) {
        // Loop-originated: classified by the linked loop's apiKeySource.
        if (loopApiKeySourceById.get(row.sourceLoopId) === "none") {
          subscriptionEstimatedCost += estimatedCost;
        } else {
          apiEstimatedCost += estimatedCost;
        }
      } else if (isSubscriptionBillingMode(row.billingMode)) {
        // DESKTOP_SYNC (no source Loop): classified by the synced billingMode.
        // A subscription/seat mode counts toward subscription cost; any other
        // value (API key, unknown, legacy null) falls through to API cost.
        subscriptionEstimatedCost += estimatedCost;
      } else {
        apiEstimatedCost += estimatedCost;
      }
    }

    // FEA-3156: the delivery-summary metrics (PRs shipped, median PR size,
    // merged KLOC per dollar) for the SAME matched-session set, via the
    // delivery-KPI SSOT engine. The KLOC-per-dollar denominator reuses the
    // API-billed cost classified above — NOT the raw aggregate total — so
    // subscription-covered "would-have-cost" (which the billing-mode contract
    // excludes from real spend) never inflates the denominator and deflates
    // KLOC/$. This also keeps `/agent-sessions/usage` bounded by the DB
    // aggregates rather than re-materializing the sessions to sum cost.
    const deliveryMetrics = await computeAgentSessionDeliveryMetrics(
      where,
      apiEstimatedCost
    );

    // Sessions whose owner was deleted have a null userId (SetNull); they are
    // grouped under a null key that maps to no user and is dropped below.
    const groupedUserIds = byUserGroup
      .map((group) => group.userId)
      .filter((value): value is string => value != null);
    const users = groupedUserIds.length
      ? await withDb((db) =>
          db.user.findMany({
            where: {
              organizationId: input.organizationId,
              id: {
                in: groupedUserIds,
              },
            },
            select: basicUserSelect.select,
          })
        )
      : [];
    const usersById = new Map(
      users.map((user) => [user.id, toBasicUser(user)])
    );

    const byUser: AgentSessionUsageByUser[] = byUserGroup
      .map((group) => {
        const user = group.userId ? usersById.get(group.userId) : null;
        if (!user) {
          return null;
        }
        return {
          userId: user.id,
          userName: displayUserName(user),
          userEmail: user.email,
          userAvatarUrl: user.avatarUrl,
          sessionCount: group._count._all,
          inputTokens: tokenCountToNumber(group._sum.inputTokens),
          outputTokens: tokenCountToNumber(group._sum.outputTokens),
          cacheReadTokens: tokenCountToNumber(group._sum.cacheReadTokens),
          cacheWriteTokens: tokenCountToNumber(group._sum.cacheWriteTokens),
          estimatedCost: decimalToNumber(group._sum.estimatedCost),
        };
      })
      .filter((value): value is AgentSessionUsageByUser => value != null)
      .sort((left, right) => right.estimatedCost - left.estimatedCost);

    const byModel: AgentSessionUsageByModel[] = byModelGroup
      .map((group) => ({
        model: group.model,
        sessionCount: group._count._all,
        inputTokens: tokenCountToNumber(group._sum.inputTokens),
        outputTokens: tokenCountToNumber(group._sum.outputTokens),
        cacheReadTokens: tokenCountToNumber(group._sum.cacheReadTokens),
        cacheWriteTokens: tokenCountToNumber(group._sum.cacheWriteTokens),
        estimatedCost: decimalToNumber(group._sum.estimatedCost),
      }))
      .sort((left, right) => right.estimatedCost - left.estimatedCost);

    const byHarness = byHarnessGroup
      .map((group) => ({
        harness: group.harness,
        sessionCount: group._count._all,
        inputTokens: tokenCountToNumber(group._sum.inputTokens),
        outputTokens: tokenCountToNumber(group._sum.outputTokens),
        cacheReadTokens: tokenCountToNumber(group._sum.cacheReadTokens),
        cacheWriteTokens: tokenCountToNumber(group._sum.cacheWriteTokens),
        estimatedCost: decimalToNumber(group._sum.estimatedCost),
      }))
      .sort((left, right) => right.sessionCount - left.sessionCount);

    // Repository facet feed (Filter → Repository). Sessions without a captured
    // repository (null) are dropped — there's nothing to filter to.
    const byRepository: AgentSessionRepositoryBreakdown[] = (
      byRepositoryGroup ?? []
    )
      .filter(
        (group): group is typeof group & { repositoryFullName: string } =>
          group.repositoryFullName != null
      )
      .map((group) => ({
        repositoryFullName: group.repositoryFullName,
        sessionCount: group._count._all,
        inputTokens: tokenCountToNumber(group._sum.inputTokens),
        outputTokens: tokenCountToNumber(group._sum.outputTokens),
        estimatedCost: decimalToNumber(group._sum.estimatedCost),
        errorCount: group._sum.errorCount ?? 0,
      }))
      .sort((left, right) => right.sessionCount - left.sessionCount);
    const summary: AgentSessionUsageSummary = {
      viewerScope: toViewerScope(input.filters),
      totalSessions: aggregate._count._all,
      earliestSessionAt:
        aggregate._min?.sessionStartedAt?.toISOString() ?? null,
      latestSessionAt: aggregate._max?.sessionStartedAt?.toISOString() ?? null,
      totalInputTokens: tokenCountToNumber(aggregate._sum.inputTokens),
      totalOutputTokens: tokenCountToNumber(aggregate._sum.outputTokens),
      totalCacheReadTokens: tokenCountToNumber(aggregate._sum.cacheReadTokens),
      totalCacheWriteTokens: tokenCountToNumber(
        aggregate._sum.cacheWriteTokens
      ),
      totalEstimatedCost: decimalToNumber(aggregate._sum.estimatedCost),
      subscriptionEstimatedCost,
      apiEstimatedCost,
      // FEA-3156: delivery-summary metrics wired for the Sessions page top row.
      mergedPrCount: deliveryMetrics.mergedPrCount,
      medianPrSize: deliveryMetrics.medianPrSize,
      mergedKlocPerDollar: deliveryMetrics.mergedKlocPerDollar,
      byUser,
      ...(attributionLenses.byBranch.length > 0
        ? { byBranch: attributionLenses.byBranch }
        : {}),
      ...(attributionLenses.byPr.length > 0
        ? { byPr: attributionLenses.byPr }
        : {}),
      byModel,
      byHarness,
      byRepository,
      lastSyncTargets: lastSyncTargets.map(toLastSyncTarget),
    };

    emitTelemetryMetric({
      metric: "agent_sessions.dashboard.query_latency",
      organizationId: input.organizationId,
      viewerScope: toViewerScope(input.filters),
      value: Date.now() - startedAtMs,
    });

    return summary;
  },

  async findExportRows(
    input: SessionUsageInput
  ): Promise<{ rows: AgentSessionCsvExportRow[]; orgSlug: string | null }> {
    const where = buildWhere(input, input.filters);

    const organization = await withDb((db) =>
      db.organization.findUnique({
        where: { id: input.organizationId },
        select: { slug: true },
      })
    );

    const aggregated = new Map<string, AgentSessionCsvExportRow>();

    // Stream sessionDetail rows in keyset-paginated batches rather than loading
    // every matching row at once. sessionDetail grows with every agent run, so a
    // single unbounded findMany can exhaust serverless memory for heavy orgs. The
    // aggregation Map and final sort are unchanged, and the batch order keeps the
    // original (sessionStartedAt, createdAt) ordering with artifactId — the
    // primary key — as a deterministic tiebreaker, so the emitted CSV is
    // identical to the previous single-query implementation.
    let cursorId: string | undefined;
    for (;;) {
      const batch = await withDb((db) =>
        db.sessionDetail.findMany({
          where,
          orderBy: [
            { sessionStartedAt: "desc" },
            { createdAt: "desc" },
            { artifactId: "desc" },
          ],
          take: EXPORT_BATCH_SIZE,
          ...(cursorId ? { cursor: { artifactId: cursorId }, skip: 1 } : {}),
          select: { ...agentSessionExportSelect, artifactId: true },
        })
      );

      if (batch.length === 0) {
        break;
      }

      for (const session of batch) {
        const userKey = session.user?.id ?? "unattributed";
        for (const row of toCsvExportRows(session)) {
          const key = [
            row.date,
            userKey,
            row.team,
            row.project,
            row.harnessType,
            row.model,
          ].join("::");
          const current = aggregated.get(key);
          if (!current) {
            aggregated.set(key, row);
            continue;
          }
          current.sessionCount += 1;
          current.inputTokens += row.inputTokens;
          current.outputTokens += row.outputTokens;
          current.cacheCreationTokens += row.cacheCreationTokens;
          current.cacheReadTokens += row.cacheReadTokens;
          current.estimatedCost = roundCost(
            current.estimatedCost + row.estimatedCost
          );
        }
      }

      if (batch.length < EXPORT_BATCH_SIZE) {
        break;
      }
      cursorId = batch.at(-1)?.artifactId;
      // artifactId is a non-null primary key on a non-empty batch, so this is a
      // safety net: a missing cursor would drop the `cursor` clause below and
      // re-fetch page one forever.
      if (!cursorId) {
        break;
      }
    }

    const rows = [...aggregated.values()].sort((left, right) => {
      if (left.date !== right.date) {
        return right.date.localeCompare(left.date);
      }
      if (left.user !== right.user) {
        return left.user.localeCompare(right.user);
      }
      return left.model.localeCompare(right.model);
    });
    return { rows, orgSlug: organization?.slug ?? null };
  },

  async findSessions(
    input: SessionListInput
  ): Promise<AgentSessionListResponse> {
    const limit = Math.min(
      input.filters.limit ?? SESSION_LIST_DEFAULT_LIMIT,
      SESSION_LIST_MAX_LIMIT
    );
    const offset = input.filters.offset ?? 0;
    // Filter the date window on lastActivityAt — the field the list is ordered
    // by — so the window means "active in this window" and the result is a
    // stable prefix shared by the dashboard and the Sessions page (FEA-2180).
    const where = buildWhere(input, input.filters, "lastActivityAt");
    const orderBy = buildAgentSessionOrderBy(input.filters);

    const [items, total] = await withDb((db) =>
      Promise.all([
        db.sessionDetail.findMany({
          where,
          select: agentSessionListSelect,
          orderBy,
          skip: offset,
          take: limit,
        }),
        db.sessionDetail.count({ where }),
      ])
    );
    const sourceArtifactsById = await findSourceArtifactsById(
      input.organizationId,
      items.map((item) => item.sourceArtifactId)
    );

    return {
      items: items.map((item) => toSessionListItem(item, sourceArtifactsById)),
      total,
      viewerScope: toViewerScope(input.filters),
    };
  },

  /**
   * Fetch org-scoped session list-item summaries for a set of Session artifact
   * ids (`SessionDetail.artifactId`), in the same wire shape the Sessions page
   * consumes. Reuses `agentSessionListSelect` + `toSessionListItem` so callers
   * (e.g. the agent-component detail "Sessions" tab) never re-derive the list
   * projection. Rows are org-scoped via `artifact.organizationId`; ids from
   * another org are silently dropped. Returns items ordered by `lastActivityAt`
   * descending. An empty id list short-circuits with no query.
   */
  async listByArtifactIds(
    organizationId: string,
    artifactIds: readonly string[]
  ): Promise<AgentSessionListItem[]> {
    const ids = [...new Set(artifactIds)].filter(isUuid);
    if (ids.length === 0) {
      return [];
    }

    const records = await withDb((db) =>
      db.sessionDetail.findMany({
        where: {
          artifactId: { in: ids },
          artifact: { is: { organizationId } },
        },
        select: agentSessionListSelect,
        orderBy: { lastActivityAt: "desc" },
      })
    );

    const sourceArtifactsById = await findSourceArtifactsById(
      organizationId,
      records.map((record) => record.sourceArtifactId)
    );

    return records.map((record) =>
      toSessionListItem(record, sourceArtifactsById)
    );
  },

  async findSessionDetail(
    input: SessionDetailInput
  ): Promise<AgentSessionDetail | null> {
    const record = await withDb((db) =>
      db.sessionDetail.findFirst({
        where: {
          artifactId: input.id,
          artifact: { is: { organizationId: input.organizationId } },
        },
        select: agentSessionDetailSelect,
      })
    );

    if (!record) {
      return null;
    }

    // Org-scope enforcement (FEA-2734 / PRD-510 FR3 D4): a SessionDetail is a
    // join-reached child, so its org is validated via the parent Artifact. The
    // `where` above already pins the org; this is the single, test-enforced seam
    // (defense-in-depth) that fails loud if a future edit drops the org predicate.
    // Adoption is proven behaviorally in org-isolation.integration.test.ts
    // (cross-org id → null).
    const scoped = resolveOrgScopeVia(
      input.organizationId,
      record.artifact,
      record
    );
    if (!isOrgScopeOwned(scoped)) {
      return null;
    }

    const sourceArtifactsById = await findSourceArtifactsById(
      input.organizationId,
      [record.sourceArtifactId]
    );
    const listItem = toSessionListItem(record, sourceArtifactsById);
    const tokenUsageByModel = toTokenUsageBreakdown(record.tokenUsageByModel);
    const metadata = toMetadata(record.metadata);
    const events = record.events.map(
      (e): SyncedAgentSessionEvent => ({
        externalEventId: e.externalEventId,
        agentExternalId: e.agentExternalId,
        eventType: e.eventType,
        toolName: e.toolName,
        createdAt: e.eventCreatedAt.toISOString(),
      })
    );
    const timeline = projectAgentSessionTimelineEvents(events, { metadata });
    const models = [
      ...new Set(tokenUsageByModel.map((usage) => usage.model).filter(Boolean)),
    ];
    const agents = toSyncedAgents(record.agents);
    // FR8 availability summary (PLN-1289). Looked up by session identity (not
    // the nullable sessionDetailId FK) so a transcript uploaded before the
    // metadata lane resolved the link still surfaces. No URL is minted here —
    // the signed-URL read route stays separate. Main is always represented
    // (missing when it has no row yet), matching the read route (PRD AC6).
    const transcriptRows = await withDb((db) =>
      db.sessionTranscript.findMany({
        where: sessionTranscriptIdentityWhere({
          organizationId: input.organizationId,
          computeTargetId: record.computeTarget.id,
          externalSessionId: record.externalSessionId,
        }),
        select: {
          fileKey: true,
          uploadStatus: true,
          uploadedAt: true,
          lastObservedAt: true,
        },
        orderBy: { fileKey: "asc" },
      })
    );
    const transcripts = transcriptRows.map(toTranscriptAvailabilitySummary);
    if (!hasMainTranscript(transcriptRows)) {
      transcripts.unshift(missingMainSummary());
    }
    return {
      ...listItem,
      models: models.length > 0 ? models : (listItem.models ?? []),
      metadata,
      sourceArtifactId: record.sourceArtifactId,
      sourceLoopId: record.sourceLoopId,
      tokenUsageByModel,
      attribution: toAttribution(record),
      agents,
      events,
      timeline,
      tracePhaseSources: parseJsonArray<SessionTracePhaseSource>(
        record.tracePhaseSources,
        sessionTracePhaseSourceSchema
      ),
      throttleSources: parseJsonArray<SessionTraceThrottleSource>(
        record.throttleSources,
        sessionTraceThrottleSourceSchema
      ),
      correctionSources: parseJsonArray<SessionTraceCorrectionSource>(
        record.correctionSources,
        sessionTraceCorrectionSourceSchema
      ),
      // PRD-510 G1 (AgentSessionTokenEvent) will provide tokenEvents for web parity
      turnItems: projectAgentSessionTurnItems({
        sessionId: record.artifactId,
        harness: record.harness,
        primaryModel: listItem.primaryModel ?? null,
        humanActor: {
          name: listItem.user ? displayUserName(listItem.user) : null,
          color:
            buildUserColor(listItem.user) ?? DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
        },
        agents,
        events,
        timeline,
        tokenUsageByModel,
      }),
      transcripts,
    };
  },

  async getAnalytics(input: SessionUsageInput): Promise<AgentSessionAnalytics> {
    const where = buildWhere(input, input.filters);
    const scalarSessions = await findPagedRecords<AnalyticsScalarSessionRecord>(
      (cursorId) =>
        withDb((db) =>
          db.sessionDetail.findMany({
            where,
            select: analyticsScalarSelect,
            orderBy: { artifactId: "asc" },
            take: ANALYTICS_QUERY_BATCH_SIZE,
            ...(cursorId
              ? {
                  cursor: { artifactId: cursorId },
                  skip: 1,
                }
              : {}),
          })
        )
    );
    const jsonSessions = await findPagedRecords<AnalyticsJsonSessionRecord>(
      (cursorId) =>
        withDb((db) =>
          db.sessionDetail.findMany({
            where,
            select: analyticsJsonSelect,
            orderBy: { artifactId: "asc" },
            take: ANALYTICS_QUERY_BATCH_SIZE,
            ...(cursorId
              ? {
                  cursor: { artifactId: cursorId },
                  skip: 1,
                }
              : {}),
          })
        )
    );

    const byTool = aggregateByTool(jsonSessions);
    const byAgentType = aggregateByAgentType(jsonSessions);
    const byRepository = aggregateByRepository(scalarSessions);
    const byProject = aggregateByProject(scalarSessions);
    const attributionLenses = await aggregateSessionAttributionLenses(where);

    return {
      viewerScope: toViewerScope(input.filters),
      byTool,
      byAgentType,
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
      inputTokens: tokenCountToNumber(aggregate._sum.inputTokens),
      outputTokens: tokenCountToNumber(aggregate._sum.outputTokens),
      cacheReadTokens: tokenCountToNumber(aggregate._sum.cacheReadTokens),
      cacheWriteTokens: tokenCountToNumber(aggregate._sum.cacheWriteTokens),
      estimatedCostUsd: decimalToNumber(aggregate._sum.estimatedCost),
      byModel: byModelGroup
        .map((group) => ({
          model: group.model,
          inputTokens: tokenCountToNumber(group._sum.inputTokens),
          outputTokens: tokenCountToNumber(group._sum.outputTokens),
          cacheReadTokens: tokenCountToNumber(group._sum.cacheReadTokens),
          cacheWriteTokens: tokenCountToNumber(group._sum.cacheWriteTokens),
          estimatedCostUsd: decimalToNumber(group._sum.estimatedCost),
        }))
        .sort((left, right) => right.estimatedCostUsd - left.estimatedCostUsd),
    };
  },

  /**
   * FEA-2730 (G1): raw per-event token rows for one session, ordered by event
   * time and optionally bounded to a date window (the Dashboard/Branches focus
   * pages read bounded 7/30/90-day windows — PRD-510 assumption 2). Org-scoped
   * through the session→artifact join (D4: join-reached — the table has no
   * organizationId), so a caller only ever reads events for sessions its org
   * owns; a foreign session id yields an empty result.
   */
  async getSessionTokenEvents(input: {
    organizationId: string;
    sessionArtifactId: string;
    start?: Date;
    end?: Date;
  }): Promise<AgentSessionTokenEventView[]> {
    const rows = await withDb((db) =>
      db.agentSessionTokenEvent.findMany({
        where: {
          agentSessionId: input.sessionArtifactId,
          session: { artifact: { organizationId: input.organizationId } },
          ...(input.start || input.end
            ? {
                eventCreatedAt: {
                  ...(input.start ? { gte: input.start } : {}),
                  ...(input.end ? { lte: input.end } : {}),
                },
              }
            : {}),
        },
        orderBy: { eventCreatedAt: "asc" },
        take: SESSION_TOKEN_EVENT_MAX_ROWS,
        select: {
          model: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          estimatedCost: true,
          eventCreatedAt: true,
        },
      })
    );
    return rows.map((row) => ({
      model: row.model,
      inputTokens: tokenCountToNumber(row.inputTokens),
      outputTokens: tokenCountToNumber(row.outputTokens),
      cacheReadTokens: tokenCountToNumber(row.cacheReadTokens),
      cacheWriteTokens: tokenCountToNumber(row.cacheWriteTokens),
      estimatedCostUsd: decimalToNumber(row.estimatedCost),
      eventCreatedAt: row.eventCreatedAt,
    }));
  },

  /**
   * FEA-2730 (G10): the per-session analytics rollup (1:1), org-scoped through
   * the session→artifact join. Returns null when the session has no synced
   * rollup or belongs to another org.
   */
  async getSessionAnalytics(input: {
    organizationId: string;
    sessionArtifactId: string;
  }): Promise<AgentSessionUsageRollupView | null> {
    const row = await withDb((db) =>
      db.agentSessionUsageRollup.findFirst({
        where: {
          artifactId: input.sessionArtifactId,
          session: { artifact: { organizationId: input.organizationId } },
        },
      })
    );
    if (!row) {
      return null;
    }
    return {
      startedAt: row.startedAt,
      startedDay: row.startedDay,
      status: row.status,
      harness: row.harness,
      isHuman: row.isHuman,
      humanTurns: row.humanTurns,
      agentTurns: row.agentTurns,
      eventCount: row.eventCount,
      toolInvocations: row.toolInvocations,
      errorEvents: row.errorEvents,
      inputTokens: tokenCountToNumber(row.inputTokens),
      outputTokens: tokenCountToNumber(row.outputTokens),
      cacheReadTokens: tokenCountToNumber(row.cacheReadTokens),
      cacheWriteTokens: tokenCountToNumber(row.cacheWriteTokens),
      estimatedCostUsd: decimalToNumber(row.estimatedCost),
      // runtime_ms is BigInt in the DB (widened to avoid int4 overflow on long
      // sessions); the view exposes it as number|null, preserving null.
      runtimeMs: row.runtimeMs == null ? null : Number(row.runtimeMs),
      rollupUpdatedAt: row.rollupUpdatedAt,
    };
  },
};
