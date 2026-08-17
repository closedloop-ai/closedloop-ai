import { formatCurrency } from "@closedloop-ai/loops-api/currency";
import { resolveSessionQuality } from "@repo/api/src/agent-session-filters";
import {
  buildUserColor,
  DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
} from "@repo/api/src/agent-session-user-color";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
  DesktopAgentSessionsPayload,
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
  SyncedActivitySegmentRow,
  TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import { MAX_STORED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import { normalizeActivitySegmentEvidenceLayers } from "@repo/api/src/types/agent-session-activity-evidence";
import { reconcileCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-reconcile";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { ArtifactSessionUsageSummary } from "@repo/api/src/types/session-artifact-link";
import { locPerDollarFromLines } from "@repo/api/src/utils/loc-per-dollar";
import { withDb } from "@repo/database";
import {
  type ActivitySegmentTokenEvent,
  buildActivitySegments,
} from "@repo/lib/sessions/activity-segment-aggregation";
import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/lib/sessions/agent-session-detail-projection";
import {
  aggregateArtifactUsageByTargetShare,
  aggregateSessionAttributionLenses,
} from "@/lib/agent-session-attribution";
import {
  sessionTraceCorrectionSourceSchema,
  sessionTracePhaseSourceSchema,
  sessionTraceThrottleSourceSchema,
} from "@/lib/desktop-agent-sessions-schema";
import { isOrgScopeOwned, resolveOrgScopeVia } from "@/lib/org-scope";
import { toNumber } from "@/lib/prisma-number";
import { displayUserName } from "@/lib/user-display-name";
import {
  aggregateByAgentType,
  aggregateByProject,
  aggregateByRepository,
  aggregateByTool,
  aggregateFullArtifactSessionUsageByModel,
} from "./service/analytics-aggregation";
import { parseJsonArray, toMetadata } from "./service/coercion";
import {
  countAuthoritativeTokenEventCosts,
  isCostReconciliationSensitiveQuery,
  reconcileSessionCost,
} from "./service/cost-authority";
import { getReconciledCostsBySessionId } from "./service/cost-reconciled-reader";
import {
  type AgentSessionCsvExportRow,
  collectAggregatedCsvExportRows,
} from "./service/csv-export";
import { listSessionsByArtifactIds } from "./service/list-by-artifact-ids";
import { resolveSessionListPage } from "./service/list-page-fetch";
import { loadListTranscriptDispositions } from "./service/list-transcript-dispositions";
import { toViewerScope } from "./service/project-resolution";
import { toSessionListItem } from "./service/projections";
import {
  ANALYTICS_QUERY_BATCH_SIZE,
  buildAgentSessionOrderBy,
  buildIdleCountWhere,
  buildWhere,
  findPagedRecords,
  findSourceArtifactsById,
  SESSIONS_ANALYTICS_DATE_FIELD,
  SESSIONS_SURFACE_DATE_FIELD,
} from "./service/query-builder";
import {
  type AgentSessionDetailRecord,
  type AnalyticsJsonSessionRecord,
  type AnalyticsScalarSessionRecord,
  agentSessionDetailSelect,
  agentSessionDetailSelectWithoutActivitySegments,
  analyticsJsonSelect,
  analyticsScalarSelect,
  SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS,
  type SessionDetailInput,
  type SessionListInput,
  type SessionUsageInput,
  type UpsertSessionsContext,
} from "./service/records";
import { isDisplayValueSort } from "./service/session-sort-order";
import {
  toAttribution,
  toBoundedDetailEvents,
  toSyncedAgents,
  toTokenUsageBreakdown,
} from "./service/synced-payload";
import { upsertSessionsBatch } from "./service/upsert-sessions-batch";
import { buildUsageSummary } from "./service/usage-summary";
import { buildUsageSummaryWhere } from "./service/usage-summary-where";
import {
  deriveTranscriptDisposition,
  hasMainTranscript,
  missingMainSummary,
  sessionTranscriptGroupKey,
  sessionTranscriptIdentityWhere,
  toTranscriptAvailabilitySummary,
} from "./transcript-availability";

const SESSION_LIST_DEFAULT_LIMIT = 25;
const SESSION_LIST_MAX_LIMIT = 100;
// Defensive ceiling for the keep-all, unretained per-event token stream: a
// single pathological session must not load an unbounded number of rows into
// memory. The focus pages read bounded date windows well under this; the cap is
// a safety limit, not a functional page size.
const SESSION_TOKEN_EVENT_MAX_ROWS = 10_000;

/**
 * FEA-2730 (G1): read view for one raw per-event token row. Token counts and
 * cost are narrowed from BigInt/Decimal to JS numbers within the 2^53 envelope.
 * A missing cost remains null so readers never confuse unknown with real zero.
 */
type AgentSessionTokenEventView = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number | null;
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
   * owns the per-session transaction sequencing plus the post-commit
   * `Loop.sessionArtifactId` back-link, and this file is grandfathered
   * shrink-only. The method stays here because the route and its tests address
   * the service object (same split as `buildUsageSummary`).
   */
  upsertSessions(
    context: UpsertSessionsContext,
    payload: DesktopAgentSessionsPayload
  ): Promise<{ persistedSessionIds: string[] }> {
    // FEA-1718: the ingest batch moved to `service/upsert-sessions-batch.ts` —
    // it owns the per-session transaction sequencing, the batch-level
    // retired-status fold tally (ISS-5648), and the post-commit
    // `Loop.sessionArtifactId` back-link, and this file is grandfathered
    // shrink-only. The method stays here because the route and its tests
    // address the service object (same split as `buildUsageSummary`).
    return upsertSessionsBatch(context, payload);
  },

  async getUsageSummary(
    input: SessionUsageInput
  ): Promise<AgentSessionUsageSummary> {
    // ISS-5809: the composition moved to `service/usage-summary.ts` — it owns
    // WHICH population each aggregate runs over plus the prior-period
    // comparison, and this file is grandfathered shrink-only. The method stays
    // here because the route and its tests address the service object.
    return await buildUsageSummary(input);
  },

  async findExportRows(
    input: SessionUsageInput
  ): Promise<{ rows: AgentSessionCsvExportRow[]; orgSlug: string | null }> {
    // FEA-4326 (export sibling of FEA-4298/ISS-4429): a CSV export of the current
    // Sessions view must select the SAME cohort the table paints. Previously this
    // called `buildWhere` with its default `sessionStartedAt` date field, so the
    // export windowed on "STARTED in range" while the table (`findSessions`) and
    // the summary cards window on `lastActivityAt` ("ACTIVE in range"). For the
    // same submitted filters a long-running session that started before the window
    // but was active inside it landed in the table yet fell out of the export —
    // breaking audit/reconciliation. Route the export through the SAME cohort
    // resolver the summary uses (`buildUsageSummaryWhere`), which pins the
    // `lastActivityAt` window AND applies the identical cost-bucket reconciliation
    // the table does, so the exported source ids match the table ids exactly.
    const where = await buildUsageSummaryWhere(input);

    const [organization, rows] = await Promise.all([
      withDb((db) =>
        db.organization.findUnique({
          where: { id: input.organizationId },
          select: { slug: true },
        })
      ),
      // Stream + aggregate the cohort into per-(date, user, team, project,
      // harness, model) CSV rows in `service/csv-export.ts` (the export concern),
      // keeping this composition root thin.
      collectAggregatedCsvExportRows(where),
    ]);

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
    const costSensitive = isCostReconciliationSensitiveQuery(input.filters);
    // FEA-4276: on the cost-sensitive path the cost-bucket clause must NOT go into
    // the DB `where` — it predicates on the stale `estimatedCost` rollup, but the
    // bucket is re-applied on the reconciled value in `findCostReconciledPage`.
    // Strip `costBuckets` so `buildWhere` omits `buildCostBucketWhere`; every
    // other facet stays, so the candidate population is correct minus only cost.
    const whereFilters = costSensitive
      ? { ...input.filters, costBuckets: undefined }
      : input.filters;
    // Window on the shared `SESSIONS_SURFACE_DATE_FIELD` (lastActivityAt) — the
    // field the list orders by, and the SAME constant `getUsageSummary` windows
    // on, so table and cards stay one cohort for a date range (FEA-2180/FEA-4298).
    const where = buildWhere(input, whereFilters, SESSIONS_SURFACE_DATE_FIELD);
    // FEA-4297/FEA-4300: Duration and Owner sort by a DERIVED display value with
    // no single trustworthy DB column, so — like the cost-reconcile path — they
    // fetch a bounded candidate set and order/paginate in memory against the
    // exact rendered value (`findDisplayValueSortedPage`).
    const displayValueSorted = isDisplayValueSort(input.filters.sortBy);
    const orderBy = buildAgentSessionOrderBy(input.filters);
    // FEA-3284/FEA-3345: count idle rows hidden by a `substantive` view (scoped to
    // every OTHER filter so the reveal label is accurate) ONLY when the effective
    // quality — resolved through the SAME `DEFAULT_SESSION_QUALITY` seam
    // `applyQualityFilter` uses so the two can't desync — is `substantive`; `all`
    // hides nothing, so we skip the extra count.
    const effectiveQuality = resolveSessionQuality(input.filters.quality);
    const idleWhere =
      effectiveQuality === "substantive"
        ? buildIdleCountWhere(input, whereFilters, SESSIONS_SURFACE_DATE_FIELD)
        : null;

    // Dispatch to the cost-reconciled, display-value, or DB-paginated path (see
    // `resolveSessionListPage`); cost/duration/owner order by a value the DB
    // column can't be trusted for and resolve in memory (FEA-4276/4297/4300).
    const {
      items,
      total,
      idleCount,
      costAuthorityById: reconciledPageCostAuthority,
    } = await resolveSessionListPage({
      costSensitive,
      displayValueSorted,
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
    const transcriptDispositionByKey = await loadListTranscriptDispositions(
      input.organizationId,
      items.map((item) => ({
        computeTargetId: item.computeTarget.id,
        externalSessionId: item.externalSessionId,
      }))
    );
    // FEA-4276: reconcile each row's cost against the per-event token stream (the
    // same captured-cost authority the detail path uses), so list and detail can
    // never disagree. On the cost-sensitive path `findCostReconciledPage` ALREADY
    // resolved this authority for the page — reuse that exact snapshot instead of
    // a second read (thread E: a sync/reprice between the two reads could show a
    // cost outside the selected bucket/order). The DB-paginated path doesn't
    // reconcile for filter/order, so it resolves the display cost here in one
    // grouped query.
    const costAuthorityById =
      reconciledPageCostAuthority ??
      (await getReconciledCostsBySessionId({
        organizationId: input.organizationId,
        sessionIds: items.map((item) => item.artifactId),
      }));

    return {
      items: items.map((item) =>
        toSessionListItem(
          item,
          sourceArtifactsById,
          transcriptDispositionByKey.get(
            sessionTranscriptGroupKey({
              computeTargetId: item.computeTarget.id,
              externalSessionId: item.externalSessionId,
            })
          ),
          costAuthorityById.get(item.artifactId)
        )
      ),
      total,
      idleCount,
      viewerScope: toViewerScope(input.filters),
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

  async findSessionDetail(
    input: SessionDetailInput,
    options?: { includeActivitySegments?: boolean }
  ): Promise<AgentSessionDetail | null> {
    // FEA-3568: the branch merged-trace fan-out opts out of the activity tiling
    // (it never reads it) so a wide branch doesn't fetch + map up to
    // MAX_SYNCED_ACTIVITY_SEGMENTS rows per session only to discard them.
    const includeActivitySegments = options?.includeActivitySegments ?? true;
    // Branch into two concrete queries rather than a conditional select: Prisma
    // can't infer a payload from a union-typed `select` (it collapses `record` to
    // `unknown`), so each branch keeps its own literal select and payload type.
    const where = {
      artifactId: input.id,
      artifact: { is: { organizationId: input.organizationId } },
    };
    const record = includeActivitySegments
      ? await withDb((db) =>
          db.sessionDetail.findFirst({
            where,
            select: agentSessionDetailSelect,
          })
        )
      : await withDb((db) =>
          db.sessionDetail.findFirst({
            where,
            select: agentSessionDetailSelectWithoutActivitySegments,
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
    const { events, truncation } = toBoundedDetailEvents(record.events);
    const timeline = projectAgentSessionTimelineEvents(events, { metadata });
    const models = [
      ...new Set(tokenUsageByModel.map((usage) => usage.model).filter(Boolean)),
    ];
    const agents = toSyncedAgents(record.agents);
    // FEA-3461 (PRD-510 G1): thread per-event cost points into the turn-item
    // projection so cloud/web detail renders the per-turn cost + cumulative
    // spend badges at parity with Local (which threads real per-token cost via
    // attributeTokenEventCosts). The projection re-sorts by tMs; a session with
    // no synced token events yields `[]`, leaving costDelta/cum undefined/0 as
    // before.
    const tokenEvents: TokenEventCostPoint[] = record.tokenEvents.map(
      (tokenEvent) => ({
        tMs: tokenEvent.eventCreatedAt.getTime(),
        costUsd: toNumber(tokenEvent.estimatedCost),
      })
    );
    // FEA-3568: expose the raw activity-segment tiling on the detail read
    // (org-scoped via the SessionDetail join above). BigInt bounds -> number and
    // classifierVersion -> version to match the SyncedActivitySegmentRow shape;
    // evidenceLayers is a Json string[] persisted verbatim. The derived per-phase
    // aggregation is FEA-2275's job (it consumes these rows); empty means the
    // session predates the upsync so the surface shows the honest fallback.
    // `activitySegmentRows` is present only when the segment select was used
    // (the branch-trace path opts out), so read it through an optional shape and
    // fall back to empty — never fetched means never mapped.
    const activitySegmentRecordsRaw =
      (
        record as {
          activitySegmentRows?: AgentSessionDetailRecord["activitySegmentRows"];
        }
      ).activitySegmentRows ?? [];
    // ISS-4541 (P1 #4): the detail select reads one past the stored-tiling
    // ceiling (`MAX_STORED_ACTIVITY_SEGMENTS + 1`) so a read that HIT the bound is
    // detectable. When it did, we serve the bounded prefix AND set
    // `activitySegmentRowsTruncated` so the read-side truncation is honest (never
    // a silent undercount) — mirroring the wire signal's semantics. A normal
    // (<= ceiling) tiling is served whole with the flag absent.
    const activitySegmentRowsReadTruncated =
      activitySegmentRecordsRaw.length > MAX_STORED_ACTIVITY_SEGMENTS;
    const activitySegmentRecords = activitySegmentRowsReadTruncated
      ? activitySegmentRecordsRaw.slice(0, MAX_STORED_ACTIVITY_SEGMENTS)
      : activitySegmentRecordsRaw;
    const activitySegmentRows: SyncedActivitySegmentRow[] =
      activitySegmentRecords.map((segment) => ({
        phase: segment.phase,
        startMs: Number(segment.startMs),
        endMs: Number(segment.endMs),
        confidence: segment.confidence,
        evidenceLayers: normalizeActivitySegmentEvidenceLayers(
          segment.evidenceLayers
        ),
        version: segment.classifierVersion,
        workItemRef: segment.workItemRef,
        subagentId: segment.subagentId,
      }));
    // FEA-2275: derive the per-phase activity breakdown from the raw tiling +
    // the session's token events, using the SAME shared @repo/lib aggregator the
    // desktop `mapDetail` runs — so web and desktop render identical breakdowns
    // (PLN-1198 Amendment v3 item 3). The cloud never re-classifies; it only
    // bins the already-priced events into the tiling spans. Token counts + cost
    // ride the widened `tokenEvents` select (BigInt/Decimal -> number here). A
    // session with no raw rows yields `[]` (the branch merged-trace path, which
    // opts out of the segment select, always does), and the renderer falls back
    // to the honest single catch-all segment.
    //
    // Cap awareness: the per-event token query is bounded by
    // SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS, so a very long session's events are
    // truncated. `estimatedCost` already falls back to the stored rollup when
    // capped (below); the breakdown must do the same rather than ship a
    // truncated per-phase sum whose header would then diverge from the
    // properties-panel cost badge. When capped we omit the derived segments so
    // the renderer shows the honest fallback priced from the (cap-aware) session
    // total, keeping the two totals reconciled. The desktop path has the full
    // local event set and needs no cap (so a pathological >cap session is the
    // one place web/desktop can differ — each is honest for what it can see).
    const isCapped = tokenEvents.length >= SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS;
    // ISS-5075: attribution walks back to the nearest turn at or before each
    // token event, so turns ending at the cap pile later spend onto the last.
    const costPointsUnreliable = isCapped || truncation.eventsTruncated;
    const activitySegments = isCapped
      ? []
      : buildActivitySegments(
          activitySegmentRows,
          record.tokenEvents.map(
            (tokenEvent): ActivitySegmentTokenEvent => ({
              tMs: tokenEvent.eventCreatedAt.getTime(),
              costUsd: toNumber(tokenEvent.estimatedCost),
              inputTokens: Number(tokenEvent.inputTokens),
              outputTokens: Number(tokenEvent.outputTokens),
              cacheReadTokens: Number(tokenEvent.cacheReadTokens),
              cacheWriteTokens: Number(tokenEvent.cacheWriteTokens),
            })
          )
        );
    // FEA-2926 / FEA-4276: derive estimatedCost from per-event costs when
    // available so the properties panel total and per-turn sum agree by
    // construction. Falls back to the stored rollup for sessions without token
    // events (Codex/OTel) or when the query hit the cap (truncated sum would
    // under-report). Uses the SAME `reconcileSessionCost` authority the Sessions
    // LIST now derives from, so list and detail can never disagree (FEA-4276).
    const reconciledEstimatedCost = reconcileSessionCost({
      tokenEventCount: tokenEvents.length,
      // COMPLETENESS (ISS-4882): legacy omission remains literal zero because
      // the migration performs no backfill; new partial summaries can carry a
      // knowingly incomplete subtotal. Count legacy positive rows and complete
      // summaries (including truthful zero), mirroring the list SQL predicate.
      pricedEventCount: countAuthoritativeTokenEventCosts(record.tokenEvents),
      tokenEventCostSum: tokenEvents.reduce((sum, e) => sum + e.costUsd, 0),
      // INGEST COMPLETENESS (FEA-4276 shafty review): cross-check the per-event
      // input+output token counts against the desktop rollup token total so a
      // dropped/overflowed ingest chunk (fewer rows than the session has, below
      // the read cap) falls back to the rollup instead of trusting a partial sum.
      // The list path derives the same pair from its bulk `tokenSum` aggregate and
      // the candidate rollup token total, so list and detail agree on this gate.
      tokenEventTokenSum: record.tokenEvents.reduce(
        (sum, e) => sum + Number(e.inputTokens) + Number(e.outputTokens),
        0
      ),
      rollupTokenTotal:
        toNumber(record.inputTokens) + toNumber(record.outputTokens),
      storedRollup: listItem.estimatedCost,
    });
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
          // FEA-3476: reason a terminally-skipped file is permanently absent.
          permanentFailureReason: true,
        },
        orderBy: { fileKey: "asc" },
      })
    );
    const transcripts = transcriptRows.map(toTranscriptAvailabilitySummary);
    if (!hasMainTranscript(transcriptRows)) {
      transcripts.unshift(missingMainSummary());
    }
    // FEA-3479 (PRD-536 G1): session-level verdict for lag-aware clients,
    // derived from the same per-file summaries (no separate DB read).
    const transcriptDisposition = deriveTranscriptDisposition(transcripts);
    return {
      ...listItem,
      // ISS-4621: `listItem` was projected WITHOUT the detail-computed transcript
      // disposition (the list path batches it; the detail path derives it here
      // from `transcripts`), so its `cloudSyncState` defaulted to `synced`.
      // Reconcile it against the blob lane so a session with derived data but a
      // still-`syncing` transcript (SES-78221) reports `pending`, not a false
      // `synced`. Same SSOT helper the list projection uses.
      cloudSyncState: reconcileCloudSyncState(transcriptDisposition),
      estimatedCost: reconciledEstimatedCost,
      cost: formatCurrency(reconciledEstimatedCost),
      // FEA-4250: the detail path reconciles cost from per-event token costs
      // (FEA-2926), so recompute KLOC/$ against that reconciled denominator to
      // keep it consistent with the served Cost.
      // FEA-4378: the NUMERATOR must match the list projection's — the roll-up of
      // `max(localWorkingTreeDiff, authoredPrLinesChanged)`, NOT the line-only
      // local diff. `listItem.authoredPrLinesChanged` already carries the gated
      // authored-PR roll-up (0 when no head branch resolves), so reuse it here.
      // Using the local diff alone would serve the tiny working-tree ratio on the
      // detail KLOC/$ card, so a multi-PR session whose branches merged/reset would
      // read ~0 there even though the list already shows the real delivered figure.
      // `kloc` (line-only relative to cost, but roll-up-based) is taken from
      // listItem unchanged; only KLOC/$ needs the reconciled denominator.
      locPerDollar: locPerDollarFromLines(
        Math.max(
          (listItem.linesAdded ?? 0) + (listItem.linesRemoved ?? 0),
          listItem.authoredPrLinesChanged ?? 0
        ),
        reconciledEstimatedCost
      ),
      models: models.length > 0 ? models : (listItem.models ?? []),
      metadata,
      sourceArtifactId: record.sourceArtifactId,
      sourceLoopId: record.sourceLoopId,
      tokenUsageByModel,
      attribution: toAttribution(record),
      agents,
      events,
      // ISS-5075: omitted means complete; the derived lanes ride this prefix.
      ...truncation,
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
      activitySegmentRows,
      // ISS-4541 (P1 #4): honest read-side truncation. Only set when the stored
      // tiling genuinely exceeded the read ceiling, so a normal tiling stays
      // unflagged. Additive/optional — omitted (falsy) means the served tiling is
      // complete.
      ...(activitySegmentRowsReadTruncated
        ? { activitySegmentRowsTruncated: true }
        : {}),
      // Additive/optional: omit when there are no priced derived segments (no
      // tiling, or capped) so the field's presence tracks real per-phase cost.
      // On the capped path `activitySegmentRows` still ship, so the renderer
      // re-derives the per-phase breakdown from the tiling with cost marked
      // unavailable rather than collapsing to a single unclassified segment
      // (ISS-4446: cost-unavailable ≠ no-attribution).
      ...(activitySegments.length > 0 ? { activitySegments } : {}),
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
        // FEA-3461 (PRD-510 G1): per-turn cost + cumulative-spend badges,
        // dropped when unreliable so they don't disagree with the rollup-based
        // properties total (FEA-2926 review feedback; ISS-5075 above).
        tokenEvents: costPointsUnreliable ? [] : tokenEvents,
        // ISS-5075: a prefix cannot end a still-running agent — see the
        // projection's formatAgentDuration.
        ...truncation,
      }),
      transcripts,
      transcriptDisposition,
    };
  },

  async getAnalytics(input: SessionUsageInput): Promise<AgentSessionAnalytics> {
    // thread wongk (ISS-4481): route the analytics read through the SAME
    // reconciled cost cohort the list/usage/export paths use, instead of
    // `buildWhere(input, input.filters)` which would run `buildCostBucketWhere`'s
    // Unknown / numeric clauses against the STALE `estimatedCost` rollup. A
    // legacy row whose rollup is 0 but whose reconciled per-event cost is $0.42
    // renders a `$` figure (not Unknown) everywhere else, so a rollup-keyed
    // analytics filter would disagree with the list/usage/export. Analytics keeps
    // its own `sessionStartedAt` date semantics (a session belongs to the period
    // it started in); `buildUsageSummaryWhere` strips `costBuckets`, resolves the
    // reconciled-matched id set, and ANDs it onto the base where — a no-op read
    // for a non-cost-sensitive query.
    const where = await buildUsageSummaryWhere(
      input,
      SESSIONS_ANALYTICS_DATE_FIELD
    );
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
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      cacheReadTokens: toNumber(row.cacheReadTokens),
      cacheWriteTokens: toNumber(row.cacheWriteTokens),
      estimatedCostUsd:
        row.estimatedCost === null ? null : toNumber(row.estimatedCost),
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
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      cacheReadTokens: toNumber(row.cacheReadTokens),
      cacheWriteTokens: toNumber(row.cacheWriteTokens),
      estimatedCostUsd: toNumber(row.estimatedCost),
      // runtime_ms is BigInt in the DB (widened to avoid int4 overflow on long
      // sessions); the view exposes it as number|null, preserving null.
      runtimeMs: row.runtimeMs == null ? null : Number(row.runtimeMs),
      rollupUpdatedAt: row.rollupUpdatedAt,
    };
  },
};
