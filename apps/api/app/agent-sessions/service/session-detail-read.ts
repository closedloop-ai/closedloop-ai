/**
 * ISS-9112: the session-detail READ, split out of `service.ts` and written
 * batch-first.
 *
 * Every database read this response needs is keyed by session identity, so the
 * scope is read ONCE for the whole id set — the stored rows, the source
 * artifacts, and the transcript archive are three reads over the population
 * rather than three per session. Each is chunked so no single statement's size
 * grows with the population; the QUERY COUNT still does not grow with the number
 * of sessions the way the per-session fan-out it replaced did.
 * `findAgentSessionDetail` is the one-id case of that same read; the branch
 * merged-trace fan-out is the many-id case.
 */

import { deriveBilledModels } from "@repo/api/src/agent-session-billed-models";
import {
  buildUserColor,
  DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
} from "@repo/api/src/agent-session-user-color";
import type {
  AgentSessionDetail,
  SyncedActivitySegmentRow,
  TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import { MAX_STORED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import { normalizeActivitySegmentEvidenceLayers } from "@repo/api/src/types/agent-session-activity-evidence";
import { reconcileCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-reconcile";
import {
  isSessionActivityMetricsUnknown,
  normalizeSessionActivityMetrics,
} from "@repo/api/src/types/session-activity-metrics-normalize";
import type { ArtifactTagPermissions } from "@repo/api/src/types/tag";
import {
  locPerDollarFromLines,
  locPerDollarNumeratorLines,
} from "@repo/api/src/utils/loc-per-dollar";
import { type Prisma, withDb } from "@repo/database";
import {
  type ActivitySegmentTokenEvent,
  buildActivitySegments,
} from "@repo/lib/sessions/activity-segment-aggregation";
import { projectAgentSessionTurnItemsFromEvents } from "@repo/lib/sessions/agent-session-detail-projection";
import { isOrgScopeOwned, resolveOrgScopeVia } from "@/lib/org-scope";
import { toNumber } from "@/lib/prisma-number";
import { displayUserName } from "@/lib/user-display-name";
import { deriveTranscriptArchiveProgress } from "../transcript-archive-progress";
import {
  deriveTranscriptVerdict,
  hasMainTranscript,
  missingMainSummary,
  sessionTranscriptGroupKey,
  sessionTranscriptIdentitiesWhere,
  type TranscriptAvailabilityRow,
  toTranscriptAvailabilitySummary,
} from "../transcript-availability";
import { readStoredAuthoritativeCostUsd } from "./authoritative-cost";
import { toMetadata } from "./coercion";
import { readPersistedDataSyncLevel } from "./data-sync-level-integrity";
import { toSessionListItem } from "./projections";
import { findSourceArtifactsById } from "./query-builder";
import {
  type AgentSessionDetailRecord,
  agentSessionDetailSelectForOrganization,
  agentSessionDetailSelectWithoutActivitySegmentsForOrganization,
  SESSION_DETAIL_TOKEN_EVENT_MAX_ROWS,
  type SessionDetailInput,
} from "./records";
import { deriveTouchedBranches } from "./session-branch-links";
import {
  reportSessionEvidenceCoverage,
  resolveSessionEvidenceCoverage,
} from "./session-evidence-coverage";
import { buildSessionEvidenceInput } from "./session-evidence-input";
import { readSessionTraceSources } from "./session-trace-source-reads";
import { readSessionUntrackedRepositoryTargets } from "./session-untracked-repositories";
import { reportCorruptAgentRoster } from "./synced-agent-roster-telemetry";
import {
  reconcileAgentRoster,
  toAttribution,
  toBoundedDetailEvents,
  toRosterIntegrity,
  toSyncedAgentRoster,
  toTokenUsageBreakdown,
} from "./synced-payload";

export type SessionDetailReadOptions = {
  includeActivitySegments?: boolean;
  includeAuthoritativeCost?: boolean;
  /**
   * Aborts the read BETWEEN queries. A population wide enough to chunk issues
   * many statements, and a caller whose request is already gone must not pay for
   * the remainder — the check therefore lives inside each chunk loop, not only
   * at the entry and exit of the whole read.
   */
  signal?: AbortSignal;
};

type SourceArtifactsById = Awaited<ReturnType<typeof findSourceArtifactsById>>;

/**
 * The detail record as the projection sees it. `activitySegmentRows` is optional
 * because the branch merged-trace fan-out opts out of the segment select — never
 * fetched must read as never mapped, not as an empty tiling that was read.
 * ISS-10721: `activityMetrics` is optional for the same reason, and its absence
 * and its `null` mean the same thing here — the rollup was not read, or there is
 * none — because both must project to the contract's unknown rather than zeros.
 */
type SessionDetailProjectionRecord = Omit<
  AgentSessionDetailRecord,
  "activitySegmentRows" | "activityMetrics"
> &
  Partial<
    Pick<AgentSessionDetailRecord, "activitySegmentRows" | "activityMetrics">
  >;

/**
 * Everything one session's projection consumes, resolved by the batched read.
 *
 * Reading and projecting are separate exports so a caller hydrating a population
 * can keep a per-session failure boundary around the projection — the read is
 * genuinely shared, a projection fault is not.
 */
export type AgentSessionDetailProjectionInput = {
  organizationId: string;
  record: SessionDetailProjectionRecord;
  sourceArtifactsById: SourceArtifactsById;
  transcriptRows: TranscriptAvailabilityRow[];
  authoritativeCostUsd: number | null;
  /**
   * ISS-8712's `tagContext`, threaded from the route's auth (ISS-10995). Omitted
   * by a caller that established no auth context — the branch merged-trace
   * fan-out — whose rows then carry no tag keys at all rather than an
   * `Unavailable` nobody computed.
   */
  tagPermissions?: ArtifactTagPermissions;
};

/** Resolve one org-scoped session detail, or null when it is not visible. */
export async function findAgentSessionDetail(
  input: SessionDetailInput,
  options?: SessionDetailReadOptions
): Promise<AgentSessionDetail | null> {
  const [[projectionInput], untrackedRepositoryTargets] = await Promise.all([
    readAgentSessionDetailInputs(
      {
        organizationId: input.organizationId,
        ids: [input.id],
        ...(input.tagPermissions === undefined
          ? {}
          : { tagPermissions: input.tagPermissions }),
      },
      options
    ),
    readSessionUntrackedRepositoryTargets({
      organizationId: input.organizationId,
      sessionArtifactId: input.id,
    }),
  ]);
  if (!projectionInput) {
    return null;
  }
  const detail = projectAgentSessionDetail(projectionInput);
  return untrackedRepositoryTargets === undefined
    ? detail
    : { ...detail, untrackedRepositoryTargets };
}

/**
 * Read everything the detail projection needs for a set of Session artifact ids.
 * Ids the org does not own are simply absent from the result, so a caller cannot
 * mistake "not visible" for "read failed".
 *
 * Every read here is chunked, and none of the chunk widths is a cap — no session
 * is dropped at any of them. They differ because what they bound differs:
 * {@link SESSION_DETAIL_READ_BATCH_SIZE} bounds MATERIALIZED ROWS (the stored-row
 * select carries per-session `events` and `tokenEvents` bounded PER PARENT, so an
 * unchunked `in` would materialize `population x 20k` relation rows at once),
 * while {@link SESSION_IDENTITY_READ_BATCH_SIZE} bounds BIND PARAMETERS for the
 * two companion reads, whose predicates spend one or two placeholders per session
 * and would otherwise walk past PostgreSQL's 65,535-parameter ceiling on a wide
 * enough branch — turning the whole population unavailable rather than serving it.
 */
export async function readAgentSessionDetailInputs(
  input: {
    organizationId: string;
    ids: readonly string[];
    tagPermissions?: ArtifactTagPermissions;
  },
  options?: SessionDetailReadOptions
): Promise<AgentSessionDetailProjectionInput[]> {
  // ISS-7229: on by default so every existing caller keeps the full detail
  // payload; the branch merged-trace fan-out opts out because it never reads
  // the field (same reasoning as `includeActivitySegments` below).
  const includeAuthoritativeCost = options?.includeAuthoritativeCost ?? true;
  // FEA-3568: the branch merged-trace fan-out opts out of the activity tiling
  // (it never reads it) so a wide branch doesn't fetch + map up to
  // MAX_SYNCED_ACTIVITY_SEGMENTS rows per session only to discard them.
  const includeActivitySegments = options?.includeActivitySegments ?? true;
  const signal = options?.signal;
  signal?.throwIfAborted();
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) {
    return [];
  }
  // Branch into two concrete queries rather than a conditional select: Prisma
  // can't infer a payload from a union-typed `select` (it collapses `record` to
  // `unknown`), so each branch keeps its own literal select and payload type.
  const records = await readStoredSessionRows(
    input.organizationId,
    ids,
    includeActivitySegments,
    signal
  );

  // Org-scope enforcement (FEA-2734 / PRD-510 FR3 D4): a SessionDetail is a
  // join-reached child, so its org is validated via the parent Artifact. The
  // `where` above already pins the org; this is the single, test-enforced seam
  // (defense-in-depth) that fails loud if a future edit drops the org predicate.
  // Adoption is proven behaviorally in org-isolation.integration.test.ts
  // (cross-org id → null).
  const scopedRecords = records.flatMap((record) => {
    const scoped = resolveOrgScopeVia(
      input.organizationId,
      record.artifact,
      record
    );
    return isOrgScopeOwned(scoped) ? [scoped.value] : [];
  });
  if (scopedRecords.length === 0) {
    return [];
  }

  const [sourceArtifactsById, transcriptRowsBySession] = await Promise.all([
    readSourceArtifactsBySession(input.organizationId, scopedRecords, signal),
    // FR8 availability summary (PLN-1289). Looked up by session identity (not
    // the nullable sessionDetailId FK) so a transcript uploaded before the
    // metadata lane resolved the link still surfaces. No URL is minted here —
    // the signed-URL read route stays separate.
    readTranscriptRowsBySession(input.organizationId, scopedRecords, signal),
  ]);
  // ISS-7229: Claude's own reported total is independent of the transcript read
  // and rides beside it. Skipped entirely for the branch merged-trace fan-out,
  // which never reads it; that caller already opts out of activity tiling for
  // the same reason.
  signal?.throwIfAborted();
  const authoritativeCostBySession = includeAuthoritativeCost
    ? readAuthoritativeCostsBySession(scopedRecords)
    : new Map<string, number | null>();

  return scopedRecords.map((record) => ({
    organizationId: input.organizationId,
    record,
    sourceArtifactsById,
    transcriptRows:
      transcriptRowsBySession.get(
        sessionTranscriptGroupKey({
          computeTargetId: record.computeTarget.id,
          externalSessionId: record.externalSessionId,
        })
      ) ?? [],
    authoritativeCostUsd:
      authoritativeCostBySession.get(record.artifactId) ?? null,
    ...(input.tagPermissions === undefined
      ? {}
      : { tagPermissions: input.tagPermissions }),
  }));
}

async function readStoredSessionRows(
  organizationId: string,
  ids: readonly string[],
  includeActivitySegments: boolean,
  signal?: AbortSignal
): Promise<SessionDetailProjectionRecord[]> {
  const records: SessionDetailProjectionRecord[] = [];
  for (const chunk of chunkForRead(ids, SESSION_DETAIL_READ_BATCH_SIZE)) {
    signal?.throwIfAborted();
    // Branch into two concrete queries rather than a conditional select: Prisma
    // can't infer a payload from a union-typed `select` (it collapses `record` to
    // `unknown`), so each branch keeps its own literal select and payload type.
    const where = {
      artifactId: { in: chunk },
      artifact: { is: { organizationId } },
    };
    records.push(
      ...(includeActivitySegments
        ? await withDb((db) =>
            db.sessionDetail.findMany({
              where,
              select: agentSessionDetailSelectForOrganization(organizationId),
            })
          )
        : await withDb((db) =>
            db.sessionDetail.findMany({
              where,
              select:
                agentSessionDetailSelectWithoutActivitySegmentsForOrganization(
                  organizationId
                ),
            })
          ))
    );
  }
  return records;
}

function chunkForRead<Value>(
  values: readonly Value[],
  size: number
): Value[][] {
  const chunks: Value[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/**
 * The source artifacts for the whole population, chunked so the `in` list cannot
 * outgrow the bind-parameter ceiling. Merged rather than concatenated: the map is
 * keyed by artifact id, which is unique across chunks, so no key is contested.
 */
async function readSourceArtifactsBySession(
  organizationId: string,
  records: readonly Pick<AgentSessionDetailRecord, "sourceArtifactId">[],
  signal?: AbortSignal
): Promise<SourceArtifactsById> {
  const merged: SourceArtifactsById = new Map();
  const sourceArtifactIds = records.map((record) => record.sourceArtifactId);
  for (const chunk of chunkForRead(
    sourceArtifactIds,
    SESSION_IDENTITY_READ_BATCH_SIZE
  )) {
    signal?.throwIfAborted();
    for (const [id, artifact] of await findSourceArtifactsById(
      organizationId,
      chunk
    )) {
      merged.set(id, artifact);
    }
  }
  return merged;
}

async function readTranscriptRowsBySession(
  organizationId: string,
  records: readonly Pick<
    AgentSessionDetailRecord,
    "computeTarget" | "externalSessionId"
  >[],
  signal?: AbortSignal
): Promise<Map<string, TranscriptAvailabilityRow[]>> {
  const rowsBySession = new Map<string, TranscriptAvailabilityRow[]>();
  const identities = records.map((record) => ({
    computeTargetId: record.computeTarget.id,
    externalSessionId: record.externalSessionId,
  }));
  // Two bind parameters per identity, so this predicate — not the id list — is
  // the one that reaches the ceiling first on a wide branch.
  for (const chunk of chunkForRead(
    identities,
    SESSION_IDENTITY_READ_BATCH_SIZE
  )) {
    signal?.throwIfAborted();
    const rows = await withDb((db) =>
      db.sessionTranscript.findMany({
        where: sessionTranscriptIdentitiesWhere(organizationId, chunk),
        select: {
          fileKey: true,
          uploadStatus: true,
          uploadedAt: true,
          lastObservedAt: true,
          // FEA-3476: reason a terminally-skipped file is permanently absent.
          permanentFailureReason: true,
          // ISS-10721: byte-level archive completeness, summed per session by
          // `deriveTranscriptArchiveProgress`.
          syncedByteOffset: true,
          rawByteSize: true,
          computeTargetId: true,
          externalSessionId: true,
        },
        orderBy: { fileKey: "asc" },
      })
    );
    for (const row of rows) {
      const key = sessionTranscriptGroupKey(row);
      const group = rowsBySession.get(key);
      if (group) {
        group.push(row);
      } else {
        rowsBySession.set(key, [row]);
      }
    }
  }
  return rowsBySession;
}

/**
 * ISS-7229: the stored `authoritative_cost_usd` column per session. ISS-12435
 * removed the loop-event fallback after backfilling its figures into the
 * column, so this reads no extra rows.
 */
function readAuthoritativeCostsBySession(
  records: readonly Pick<
    AgentSessionDetailRecord,
    "artifactId" | "authoritativeCostUsd"
  >[]
): Map<string, number | null> {
  return new Map(
    records.map((record) => [
      record.artifactId,
      readStoredAuthoritativeCostUsd(record.authoritativeCostUsd),
    ])
  );
}

/** Build one wire detail from the reads {@link readAgentSessionDetailInputs} did. */
export function projectAgentSessionDetail(
  input: AgentSessionDetailProjectionInput
): AgentSessionDetail {
  const { organizationId, record, sourceArtifactsById } = input;
  const listItem = toSessionListItem(
    record,
    sourceArtifactsById,
    undefined,
    undefined,
    undefined,
    // ISS-10995: the Details tab's Tags row IS the tag surface now, so the
    // detail serves it. Still omitted for a caller that resolved no
    // permissions — the branch merged-trace fan-out — because `tagContext`
    // needs both halves and the row must not report an empty list it never
    // read. The relation is already on this select
    // (`agentSessionDetailSelectForOrganization`), org-scoped in SQL.
    input.tagPermissions === undefined
      ? undefined
      : { organizationId, permissions: input.tagPermissions }
  );
  const tokenUsageByModel = toTokenUsageBreakdown(record.tokenUsageByModel);
  const metadata = toMetadata(record.metadata);
  const { events, truncation } = toBoundedDetailEvents(record.events);
  const models = deriveBilledModels(tokenUsageByModel);
  // ISS-6890: read the roster member by member so one version-skewed member
  // cannot collapse the whole population to a plausible `[]` while the stored
  // `agentCount` survives, then RECONCILE the result against that count
  // (#5209 review) — a null, empty, or merely short blob parses without a
  // single failure, so the parser alone would still have served an empty
  // roster beside a positive count with nothing saying it was incomplete.
  // This is the boundary where both are in scope. `rosterIntegrity` is
  // spread-shaped so a whole roster leaves `unreadableAgents` genuinely
  // OMITTED rather than serialized as a present zero — absence is the
  // contract's only encoding of "complete".
  const roster = reconcileAgentRoster(
    toSyncedAgentRoster(record.agents),
    record.agentCount
  );
  const agents = roster.agents;
  reportCorruptAgentRoster(roster, {
    sessionId: record.artifactId,
    organizationId,
    agentCount: record.agentCount,
  });
  const rosterIntegrity = toRosterIntegrity(roster);
  const traceSources = readSessionTraceSources(record, {
    organizationId,
    sessionId: record.artifactId,
  });
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
  const activitySegmentRecordsRaw = record.activitySegmentRows ?? [];
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
  // ISS-7176: the detail total is `session_detail.estimated_cost`, the same
  // column the list row and the summary cards read.
  //
  // This used to prefer the per-event sum so that the properties-panel total and
  // the per-turn breakdown agreed by construction. They still agree whenever the
  // session is priced purely per token — but when they disagree the difference is
  // usually the session-level WEB-SEARCH line item, which the rollup carries and
  // no per-event row does, and preferring the events dropped it. Agreeing with
  // the breakdown is not worth disagreeing with the truth.
  //
  // The per-turn rows are unchanged; they are a breakdown, not the total.
  const reconciledEstimatedCost = listItem.estimatedCost;
  // Main is always represented (missing when it has no row yet), matching the
  // read route (PRD AC6).
  const transcripts = input.transcriptRows.map(toTranscriptAvailabilitySummary);
  if (!hasMainTranscript(input.transcriptRows)) {
    transcripts.unshift(missingMainSummary());
  }
  // FEA-3479 (PRD-536 G1): session-level verdict for lag-aware clients,
  // derived from the same per-file summaries (no separate DB read).
  // ISS-9884: the reason rides with it, because the detail Properties Sync row
  // renders through the SAME `getSessionSyncStatus` the list row does and would
  // otherwise contradict the transcript panel directly beneath it.
  const transcriptVerdict = deriveTranscriptVerdict(transcripts);
  const transcriptDisposition = transcriptVerdict.disposition;
  // ISS-10721: the quantitative half of the same disclosure — how much of the
  // archive has actually landed, from the stored rows already read above.
  const transcriptArchiveProgress = deriveTranscriptArchiveProgress(
    input.transcriptRows
  );
  // ISS-10721: the activity-metrics rollup. `normalizeSessionActivityMetrics`
  // re-checks the stored row on the way out, so a value written by a producer
  // older than the current validity predicate cannot leave as a measurement.
  const activityMetrics = normalizeSessionActivityMetrics(
    record.activityMetrics
      ? {
          ...record.activityMetrics,
          spendLowConfUsd: decimalToNumber(
            record.activityMetrics.spendLowConfUsd
          ),
          spendMediumConfUsd: decimalToNumber(
            record.activityMetrics.spendMediumConfUsd
          ),
          spendHighConfUsd: decimalToNumber(
            record.activityMetrics.spendHighConfUsd
          ),
        }
      : null
  );
  const turnItems = projectAgentSessionTurnItemsFromEvents({
    sessionId: record.artifactId,
    harness: record.harness,
    primaryModel: listItem.primaryModel ?? null,
    // ISS-12251 D-4: the transcript's human turns are the session's creator.
    humanActor: {
      name: listItem.createdBy ? displayUserName(listItem.createdBy) : null,
      color:
        buildUserColor(listItem.createdBy ?? null) ??
        DEFAULT_HUMAN_ACTOR_COLOR_TOKEN,
    },
    agents,
    events,
    metadata,
    tokenUsageByModel,
    // FEA-3461 (PRD-510 G1): per-turn cost + cumulative-spend badges,
    // dropped when unreliable so they don't disagree with the rollup-based
    // properties total (FEA-2926 review feedback; ISS-5075 above).
    tokenEvents: costPointsUnreliable ? [] : tokenEvents,
    // ISS-5075: a prefix cannot end a still-running agent — see the
    // projection's formatAgentDuration.
    ...truncation,
  });
  // ISS-7427: this response's headline numbers come from the metadata lane,
  // which does not depend on the transcript archive — so a terminally absent
  // main transcript serves a full set of metrics with nothing saying they were
  // never backed by it. Classify that mix and log the cohort (alerted
  // Datadog-side, prod only — ISS-7517). Derived from values already in hand;
  // no extra DB read.
  const evidenceInput = buildSessionEvidenceInput({
    transcriptDisposition,
    turnItemCount: turnItems.length,
    eventsTruncated: truncation.eventsTruncated === true,
    transcripts,
    rollup: listItem,
    estimatedCostUsd: reconciledEstimatedCost,
  });
  // ISS-7427 part 3: the verdict is BOUND, not passed straight through, because
  // it is now served as well as logged. The reader is the point — logging the
  // mixed cohort made it countable by us; serving it is what lets the screen
  // stop presenting a metadata-only session as a transcript-backed one.
  const evidenceCoverage = resolveSessionEvidenceCoverage(evidenceInput);
  const dataSyncLevel = readPersistedDataSyncLevel(record.dataSyncLevel, {
    organizationId,
    sessionId: record.artifactId,
  });
  reportSessionEvidenceCoverage(
    evidenceCoverage,
    {
      organizationId,
      sessionId: record.artifactId,
      harness: record.harness,
    },
    evidenceInput
  );
  return {
    ...listItem,
    // ISS-8427: the plural companion to `listItem.branch`/`branchArtifactId`,
    // computed on the DETAIL path only — the Sessions list renders one Branch
    // cell and would carry the set for every row without a reader.
    branches: deriveTouchedBranches(record),
    // ISS-4621: `listItem` was projected WITHOUT the detail-computed transcript
    // disposition (the list path batches it; the detail path derives it here
    // from `transcripts`), so its `cloudSyncState` defaulted to `synced`.
    // Reconcile it against the blob lane so a session with derived data but a
    // still-`syncing` transcript (SES-78221) reports `pending`, not a false
    // `synced`. Same SSOT helper the list projection uses.
    cloudSyncState: reconcileCloudSyncState(transcriptDisposition),
    // FEA-4250: the detail path reconciles cost from per-event token costs
    // (FEA-2926), so recompute LOC/$ against that reconciled denominator to
    // keep it consistent with the served Cost. Only the DENOMINATOR differs
    // from the list projection's — `kloc` is taken from listItem unchanged.
    // ISS-6113: the NUMERATOR is the shared `locPerDollarNumeratorLines`, not
    // a second copy of the rule — this site used to rebuild it inline and the
    // copies drifted. ISS-9964 narrowed that numerator to merged authored PRs
    // only, so `listItem` is passed raw: there is one population now, and its
    // `null` (NOT KNOWABLE) must survive to the renderer rather than being
    // stripped into a measured-looking value.
    locPerDollar: locPerDollarFromLines(
      locPerDollarNumeratorLines(listItem),
      reconciledEstimatedCost
    ),
    models,
    metadata,
    evidenceCoverage,
    // ISS-7516: narrowed, not cast. The column is a nullable TEXT, so NULL (no
    // level reported) and an unrecognized value both become `undefined` — the
    // "cannot say" the client contract requires. The key is spread away
    // entirely rather than serialized as `null`, per the cross-repo rule for
    // absent optional wire fields.
    //
    // The two reach the wire identically ON PURPOSE and are NOT identical to
    // us: `readPersistedDataSyncLevel` logs the unrecognized one, so a
    // data-integrity incident stays separable from the pre-upgrade fleet
    // without a bad value ever reaching a reader.
    ...(dataSyncLevel === undefined ? {} : { dataSyncLevel }),
    sourceArtifactId: record.sourceArtifactId,
    // ISS-12435: Loops are removed; kept on the wire as null for skewed readers.
    sourceLoopId: null,
    authoritativeCostUsd: input.authoritativeCostUsd,
    tokenUsageByModel,
    attribution: toAttribution(record),
    agents,
    ...rosterIntegrity,
    events,
    // ISS-5075: omitted means complete; the derived lanes ride this prefix.
    ...truncation,
    // ISS-6978: member-by-member, with one monitored event per request when a
    // persisted source array could not be read whole.
    ...traceSources,
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
    turnItems,
    transcripts,
    transcriptDisposition,
    // ISS-9884: the KEY is omitted, not set to `undefined`, when no terminal
    // skip produced the verdict — an additive optional wire field the contract
    // does not declare nullable (AGENTS.md → Cross-Repo Compatibility), and
    // both other producers of this field omit it the same way.
    ...(transcriptVerdict.reason
      ? { transcriptDispositionReason: transcriptVerdict.reason }
      : {}),
    // ISS-10721: both keys are OMITTED rather than nulled when nothing was
    // measured, so a client cannot read an all-`null` object as "the rollup ran
    // and found nothing" — the contract's unknown is the field's absence.
    ...(isSessionActivityMetricsUnknown(activityMetrics)
      ? {}
      : { activityMetrics }),
    ...(transcriptArchiveProgress ? { transcriptArchiveProgress } : {}),
  };
}

/** A `Decimal(14, 6)` column as a `number`; `null` stays null. */
function decimalToNumber(value: Prisma.Decimal | null): number | null {
  return value === null ? null : value.toNumber();
}

/**
 * Sessions whose stored rows one query may carry. The select is wide — `events`
 * and `tokenEvents` are bounded per session, not per query — so this is what
 * keeps the read's materialized row count off the population size.
 */
export const SESSION_DETAIL_READ_BATCH_SIZE = 20;

/**
 * Sessions whose IDENTITY one companion query may carry. These selects have no
 * per-parent relation fan-out, so what bounds them is the statement's bind
 * parameters, not its materialized rows — the transcript predicate spends two
 * placeholders per session, so 500 sessions is 1,000 of PostgreSQL's 65,535.
 */
export const SESSION_IDENTITY_READ_BATCH_SIZE = 500;
