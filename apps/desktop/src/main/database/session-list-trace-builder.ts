import {
  createAutonomyAccumulator,
  pushAutonomyEvidenceAtTimestamp,
} from "@repo/lib/session-trace/autonomy";
import {
  deriveSessionTracePresentation,
  isSessionTerminatingLabel,
  SESSION_TRACE_SOURCE_LIMITS,
} from "@repo/lib/session-trace/derivation";
import { sessionHasParsedTranscript } from "@repo/lib/session-trace/transcript";
import { createSessionTimingAccumulator } from "../../shared/session-timing.js";
import { asRecord } from "../../shared/type-guards.js";
import type {
  ActivityBucket,
  SessionMarker,
  SyncedAgentSession,
} from "../agent-sync/agent-session-sync-contract.js";
import { parseJsonObjectText } from "../agent-sync/agent-sync-json-text.js";
import { createSessionLastActivityAccumulator } from "../agent-sync/session-date-window.js";
import {
  createArtifactSessionMarkerAccumulator,
  mergeSessionMarkers,
} from "../session/session-artifact-markers.js";
import { parseIsoMs } from "../session/session-marker-utils.js";
import type {
  SqliteArtifactLinkRow,
  SqliteEventRow,
  SqlitePullRequestRow,
  SqliteTokenEventRow,
} from "./db-row-types.js";
import type { DesktopPrismaReader } from "./prisma-client.js";
import {
  eventPages,
  readLegacyTokenEvents,
  timelineEventPages,
  tokenEventPages,
  tokenEventScanPages,
} from "./session-list-trace-pages.js";
import type { SessionListTraceProjection } from "./session-list-trace-projection.js";
import {
  buildSessionTraceSyncFields,
  buildTraceMarker,
  buildTraceTimelineRows,
  extractCorrectionSources,
  extractThrottleSources,
  fitSessionTraceSourcesToAggregateLimit,
  localPullRequestToSessionPr,
  mergeSessionPullRequests,
  resolveTraceEndMs,
  type TraceTimelineRow,
  traceRowOrder,
} from "./session-trace.js";
import {
  createActivityBucket,
  roundActivityBucket,
} from "./session-trace-activity-bucket.js";
import {
  bucketIndex,
  clampToRange,
  formatTraceClockOffset,
} from "./session-trace-activity-geometry.js";
import {
  buildSessionAutonomyInputFromTrace,
  isHumanRow,
  isPromptRow,
} from "./session-trace-autonomy-input.js";
import { resolveArtifactLinkBranch } from "./session-trace-branch-resolution.js";
import { formatTraceDuration } from "./session-trace-duration.js";
import {
  boundedLocFromMetadata,
  boundedTurnsFromMetadata,
} from "./session-trace-metadata-values.js";
import { addTraceTokenEventToBucket } from "./session-trace-token-bucket.js";
import { selectSessionEventCounts } from "./sync-source-bounded-reads.js";
import {
  readArtifactLinkRows,
  readPullRequestRows,
} from "./sync-source-rollup-reads.js";
import { buildSyncedSessionPrRef } from "./synced-pull-request-ref.js";
import { mapTraceTokenEvents } from "./trace-token-event-mapper.js";

const SESSION_TRACE_BUCKET_TARGET = 40;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ProjectionSessionRow = {
  id: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  metadata: string | null;
};

type CountRow = {
  agent_count: number | bigint;
  error_count: number;
  tool_use_count: number;
};

type Extent = {
  minMs: number;
  maxMs: number;
  malformed: boolean;
};

/**
 * Build one compact list projection without retaining raw event streams.
 * Event/token working sets are page-bounded. Canonical output cardinality still
 * permits one model bucket per distinct model and one PR ref per qualifying
 * artifact link, so those semantic outputs remain proportional to source data.
 */
export async function buildSessionListTraceProjection(
  reader: DesktopPrismaReader,
  sessionId: string
): Promise<SessionListTraceProjection | null> {
  const rows = await reader.$queryRawUnsafe<ProjectionSessionRow[]>(
    `SELECT id, started_at, updated_at, ended_at, metadata
       FROM sessions WHERE id = $1`,
    sessionId
  );
  const session = rows[0];
  if (!session) {
    return null;
  }
  const metadata = parseJsonObjectText(session.metadata);
  const metadataRows = buildTraceTimelineRows(metadata, []);
  const [links, pullRequests, countRows, viewedRows] = await Promise.all([
    readArtifactLinkRows(reader, [sessionId], { omitLinkEvidence: true }),
    readPullRequestRows(reader, [sessionId]),
    readCounts(reader, sessionId),
    reader.$queryRawUnsafe<{ viewed: number }[]>(
      "SELECT 1 AS viewed FROM session_viewership WHERE session_id = $1 LIMIT 1",
      sessionId
    ),
  ]);
  const firstPass = await scanExtentAndSources(
    reader,
    sessionId,
    metadataRows,
    session.started_at
  );
  if (firstPass.extent.malformed) {
    return buildMalformedProjection(
      reader,
      session,
      metadata,
      links,
      pullRequests,
      countRows,
      viewedRows.length > 0,
      firstPass.lastActivityAt
    );
  }
  const startedMs = parseIsoMs(session.started_at);
  const endedMs = parseIsoMs(session.ended_at);
  const updatedMs = parseIsoMs(session.updated_at);
  let endMs = updatedMs;
  if (Number.isFinite(firstPass.extent.maxMs)) {
    endMs = firstPass.extent.maxMs;
  }
  if (Number.isFinite(endedMs)) {
    endMs = endedMs;
  }
  const geometry = createGeometry(startedMs, endMs, firstPass.extent);
  const autonomyInput = buildSessionAutonomyInputFromTrace(
    metadata,
    [],
    [],
    viewedRows.length > 0
  );
  const timeline = await foldTrace(
    reader,
    sessionId,
    metadataRows,
    geometry,
    links,
    session,
    endMs,
    sessionHasParsedTranscript(metadata),
    {
      headless: autonomyInput.headless,
      sessionEnded: session.ended_at !== null,
    }
  );
  const sourceFields = fitSessionTraceSourcesToAggregateLimit({
    tracePhaseSources: [],
    throttleSources: firstPass.throttleSources,
    correctionSources: firstPass.correctionSources,
  });
  const presentation = deriveSessionTracePresentation({
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    endedAt: session.ended_at,
    ...(Number.isFinite(endMs) ? { endMs } : {}),
    promptTimestamps: [],
    agentActivityTimestamps: [],
    headless: autonomyInput.headless,
    autonomyResult: timeline.autonomy,
    phaseSources: sourceFields.tracePhaseSources,
    throttleSources: sourceFields.throttleSources,
    correctionSources: sourceFields.correctionSources,
  });
  const markers = mergeSessionMarkers(
    [...timeline.markers, ...presentation.correctionMarkers],
    timeline.artifactMarkers.finish()
  ).slice(0, SESSION_TRACE_SOURCE_LIMITS.markers);
  const diffStats = asRecord(metadata?.diffStats);
  const flatLinesAdded = boundedLocFromMetadata(diffStats?.linesAdded);
  const flatLinesRemoved = boundedLocFromMetadata(diffStats?.linesRemoved);
  const flatFilesChanged = boundedLocFromMetadata(diffStats?.filesChanged);
  const turns = boundedTurnsFromMetadata(
    metadata?.userMessages,
    metadata?.assistantMessages
  );
  return {
    agentCount: Number(countRows.agent_count),
    errorCount: Number(countRows.error_count),
    lastActivityAt: firstPass.lastActivityAt,
    toolUseCount: Number(countRows.tool_use_count),
    fields: {
      branch: resolveArtifactLinkBranch(links),
      prs: mergeSessionPullRequests(
        pullRequests.flatMap(localPullRequestToSessionPr)
      ),
      prRefs: buildPrRefs(links),
      ...durationFields(startedMs, endMs, timeline),
      ...(geometry ? activityFields(geometry, markers) : {}),
      ...(flatLinesAdded === undefined ? {} : { linesAdded: flatLinesAdded }),
      ...(flatLinesRemoved === undefined
        ? {}
        : { linesRemoved: flatLinesRemoved }),
      ...(flatFilesChanged === undefined
        ? {}
        : { filesChanged: flatFilesChanged }),
      ...(turns === undefined || turns === 0 ? {} : { turns }),
      steeringEpisodes: presentation.steeringEpisodes,
      autonomy: presentation.autonomy,
      phases: presentation.phases,
      phaseIterations: presentation.phaseIterations,
      phaseLoopbacks: presentation.phaseLoopbacks,
      throttles: presentation.throttles,
    },
  };
}

async function readCounts(
  reader: DesktopPrismaReader,
  sessionId: string
): Promise<CountRow> {
  const agentRows = await reader.$queryRawUnsafe<
    Array<{ agent_count: number | bigint }>
  >(
    "SELECT COUNT(*) AS agent_count FROM agents WHERE session_id = $1",
    sessionId
  );
  const eventCounts = await selectSessionEventCounts(reader, [sessionId]);
  const counts = eventCounts.get(sessionId);
  return {
    agent_count: agentRows[0]?.agent_count ?? 0,
    error_count: counts?.errorCount ?? 0,
    tool_use_count: counts?.toolUseCount ?? 0,
  };
}

async function scanExtentAndSources(
  reader: DesktopPrismaReader,
  sessionId: string,
  metadataRows: readonly TraceTimelineRow[],
  startedAt: string | null
): Promise<{
  extent: Extent;
  lastActivityAt: string | null;
  throttleSources: ReturnType<typeof extractThrottleSources>;
  correctionSources: ReturnType<typeof extractCorrectionSources>;
}> {
  const extent: Extent = {
    minMs: Number.NaN,
    maxMs: Number.NaN,
    malformed: false,
  };
  for (const row of metadataRows) {
    considerTimestamp(extent, row.createdAt);
  }
  const throttleSources: ReturnType<typeof extractThrottleSources> = [];
  const correctionSources: ReturnType<typeof extractCorrectionSources> = [];
  const lastActivity = createSessionLastActivityAccumulator(startedAt);
  for await (const page of eventPages(reader, sessionId)) {
    for (const event of page) {
      considerTimestamp(extent, event.created_at);
      lastActivity.push(event.created_at);
      if (
        throttleSources.length < SESSION_TRACE_SOURCE_LIMITS.throttleSources
      ) {
        throttleSources.push(...extractThrottleSources([event]));
      }
      if (
        correctionSources.length < SESSION_TRACE_SOURCE_LIMITS.correctionSources
      ) {
        correctionSources.push(...extractCorrectionSources([event]));
      }
    }
  }
  for await (const page of tokenEventScanPages(reader, sessionId)) {
    for (const event of page) {
      considerTimestamp(extent, event.created_at);
    }
  }
  return {
    extent,
    lastActivityAt: lastActivity.finish(),
    throttleSources,
    correctionSources,
  };
}

function considerTimestamp(extent: Extent, value: string): void {
  const ms = parseIsoMs(value);
  // Fixed-width UTC timestamps preserve Date.parse order in indexed text order.
  // Other accepted Date.parse shapes use the exceptional legacy array sorter.
  if (!(CANONICAL_TIMESTAMP.test(value) && Number.isFinite(ms))) {
    extent.malformed = true;
    return;
  }
  if (!(extent.minMs <= ms)) {
    extent.minMs = ms;
  }
  if (!(extent.maxMs >= ms)) {
    extent.maxMs = ms;
  }
}

type TraceGeometry = {
  buckets: ActivityBucket[];
  bucketMs: number;
  bucketCount: number;
  durationMs: number;
  windowStartMs: number;
};

function createGeometry(
  startMs: number,
  endMs: number,
  extent: Extent
): TraceGeometry | null {
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return null;
  }
  const windowStartMs = Number.isFinite(extent.minMs)
    ? clampToRange(extent.minMs, startMs, endMs)
    : startMs;
  const windowEndMs = Number.isFinite(extent.maxMs)
    ? clampToRange(extent.maxMs, windowStartMs, endMs)
    : endMs;
  const durationMs = Math.max(1, windowEndMs - windowStartMs);
  const bucketCount = Math.max(
    1,
    Math.min(
      SESSION_TRACE_BUCKET_TARGET,
      Math.ceil(durationMs / (5 * 60 * 1000))
    )
  );
  const bucketMs = durationMs / bucketCount;
  return {
    windowStartMs,
    durationMs,
    bucketMs,
    bucketCount,
    buckets: Array.from({ length: bucketCount }, (_, index) =>
      createActivityBucket({
        binStartMs: Math.round(windowStartMs + index * bucketMs),
        binEndMs: Math.round(windowStartMs + (index + 1) * bucketMs),
        label: formatTraceClockOffset(Math.round(index * bucketMs)),
      })
    ),
  };
}

async function foldTrace(
  reader: DesktopPrismaReader,
  sessionId: string,
  metadataRows: readonly TraceTimelineRow[],
  geometry: TraceGeometry | null,
  links: readonly SqliteArtifactLinkRow[],
  session: ProjectionSessionRow,
  endMs: number,
  hasTranscript: boolean,
  autonomyInput: { headless: boolean; sessionEnded: boolean }
): Promise<{
  autonomy: { autonomy: number | null; steeringEpisodes: number | null };
  markers: SessionMarker[];
  timing: ReturnType<
    ReturnType<typeof createSessionTimingAccumulator>["finish"]
  >;
  measured: boolean;
  hasTranscript: boolean;
  artifactMarkers: ReturnType<typeof createArtifactSessionMarkerAccumulator>;
}> {
  const startMs = parseIsoMs(session.started_at);
  const timing = createSessionTimingAccumulator(
    Number.isFinite(startMs) && Number.isFinite(endMs)
      ? { startMs, endMs }
      : undefined
  );
  const artifactMarkers = createArtifactSessionMarkerAccumulator({
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    endedAt: session.ended_at,
    endMs: Number.isFinite(endMs) ? endMs : undefined,
    links,
  });
  const markers: SessionMarker[] = [];
  const autonomy = createAutonomyAccumulator(autonomyInput);
  const timeline = timelineRows(reader, sessionId, metadataRows)[
    Symbol.asyncIterator
  ]();
  const tokens = tokenRows(reader, sessionId)[Symbol.asyncIterator]();
  let nextTimeline = await timeline.next();
  let nextToken = await tokens.next();
  let index = 0;
  while (!(nextTimeline.done && nextToken.done)) {
    const rowMs = nextTimeline.done
      ? Number.POSITIVE_INFINITY
      : parseIsoMs(nextTimeline.value.createdAt);
    const tokenMs = nextToken.done
      ? Number.POSITIVE_INFINITY
      : parseIsoMs(nextToken.value.created_at);
    const timeMs = Math.min(rowMs, tokenMs);
    let hasAgent = false;
    let hasPrompt = false;
    while (
      !nextTimeline.done &&
      parseIsoMs(nextTimeline.value.createdAt) === timeMs
    ) {
      const row = nextTimeline.value;
      foldTimelineRow(
        row,
        index,
        geometry,
        hasTranscript,
        timing,
        artifactMarkers,
        markers
      );
      const rowPrompt = isPromptRow(row, hasTranscript);
      hasPrompt ||= rowPrompt && !isSessionTerminatingLabel(row.label);
      hasAgent ||= !(rowPrompt || isHumanRow(row.eventType));
      index += 1;
      nextTimeline = await timeline.next();
    }
    while (
      !nextToken.done &&
      parseIsoMs(nextToken.value.created_at) === timeMs
    ) {
      foldTokenCost(nextToken.value, sessionId, geometry);
      hasAgent = true;
      nextToken = await tokens.next();
    }
    pushAutonomyEvidenceAtTimestamp(autonomy, timeMs, {
      agent: hasAgent,
      prompt: hasPrompt,
    });
  }
  return {
    autonomy: autonomy.finish(),
    markers,
    timing: timing.finish(),
    measured: index > 0,
    hasTranscript,
    artifactMarkers,
  };
}

function foldTimelineRow(
  row: TraceTimelineRow,
  index: number,
  geometry: TraceGeometry | null,
  hasTranscript: boolean,
  timing: ReturnType<typeof createSessionTimingAccumulator>,
  artifactMarkers: ReturnType<typeof createArtifactSessionMarkerAccumulator>,
  markers: SessionMarker[]
): void {
  timing.push(row);
  if (geometry) {
    const bucket =
      geometry.buckets[
        bucketIndex(
          row.createdAt,
          geometry.windowStartMs,
          geometry.bucketMs,
          geometry.bucketCount
        )
      ];
    if (bucket) {
      bucket.total += 1;
      if (row.toolName) {
        bucket.toolStart += 1;
      }
      bucket.tl0 ??= index;
    }
  }
  const marker = geometry
    ? buildTraceMarker(
        row,
        index,
        geometry.windowStartMs,
        geometry.durationMs,
        hasTranscript
      )
    : null;
  if (marker && markers.length < SESSION_TRACE_SOURCE_LIMITS.markers) {
    markers.push(marker);
  }
  artifactMarkers.observeTimelineRow(row.createdAt, index, marker);
  if (marker) {
    artifactMarkers.observeTraceMarker(marker);
  }
}

function foldTokenCost(
  event: SqliteTokenEventRow,
  sessionId: string,
  geometry: TraceGeometry | null
): void {
  if (!geometry) {
    return;
  }
  const bucket =
    geometry.buckets[
      bucketIndex(
        event.created_at,
        geometry.windowStartMs,
        geometry.bucketMs,
        geometry.bucketCount
      )
    ];
  if (bucket) {
    const mapped = mapTraceTokenEvents(sessionId, [event])[0];
    if (mapped) {
      addTraceTokenEventToBucket(bucket, mapped);
    }
  }
}

async function* timelineRows(
  reader: DesktopPrismaReader,
  sessionId: string,
  metadataRows: readonly TraceTimelineRow[]
): AsyncGenerator<TraceTimelineRow> {
  let metadataIndex = 0;
  for await (const page of timelineEventPages(reader, sessionId)) {
    for (const event of page) {
      const eventRow = eventToTimelineRow(event);
      while (
        metadataIndex < metadataRows.length &&
        timelineCompare(metadataRows[metadataIndex], eventRow) <= 0
      ) {
        yield metadataRows[metadataIndex];
        metadataIndex += 1;
      }
      yield eventRow;
    }
  }
  while (metadataIndex < metadataRows.length) {
    yield metadataRows[metadataIndex];
    metadataIndex += 1;
  }
}

function timelineCompare(
  left: TraceTimelineRow,
  right: TraceTimelineRow
): number {
  const byTime = parseIsoMs(left.createdAt) - parseIsoMs(right.createdAt);
  if (byTime !== 0) {
    return byTime;
  }
  return traceRowOrder(left) - traceRowOrder(right);
}

function eventToTimelineRow(event: SqliteEventRow): TraceTimelineRow {
  return {
    eventType: event.event_type,
    toolName: event.tool_name,
    createdAt: event.created_at,
    label: event.tool_name ?? event.summary ?? event.event_type,
  };
}

async function* tokenRows(
  reader: DesktopPrismaReader,
  sessionId: string
): AsyncGenerator<SqliteTokenEventRow> {
  for await (const page of tokenEventPages(reader, sessionId)) {
    for (const row of page) {
      yield row;
    }
  }
}

function durationFields(
  startMs: number,
  endMs: number,
  timeline: Awaited<ReturnType<typeof foldTrace>>
): Pick<SyncedAgentSession, "activeAgent" | "waitingUser" | "wallClock"> {
  const fields: Pick<
    SyncedAgentSession,
    "activeAgent" | "waitingUser" | "wallClock"
  > = {};
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    fields.wallClock = formatTraceDuration(endMs - startMs);
  }
  fields.activeAgent = timeline.measured
    ? formatTraceDuration(timeline.timing.activeAgentMs)
    : null;
  fields.waitingUser = timeline.measured
    ? formatTraceDuration(timeline.timing.waitingUserMs)
    : null;
  return fields;
}

function activityFields(
  geometry: TraceGeometry,
  markers: SessionMarker[]
): Pick<SyncedAgentSession, "activityBuckets" | "markers" | "span"> {
  return {
    activityBuckets: geometry.buckets.map(roundActivityBucket),
    span: {
      first: formatTraceClockOffset(0),
      last: formatTraceClockOffset(geometry.durationMs),
      startMs: geometry.windowStartMs,
      endMs: geometry.windowStartMs + geometry.durationMs,
    },
    ...(markers.length > 0 ? { markers } : {}),
  };
}

function buildPrRefs(links: readonly SqliteArtifactLinkRow[]) {
  return links.flatMap((link) => buildSyncedSessionPrRef(link) ?? []);
}

async function buildMalformedProjection(
  reader: DesktopPrismaReader,
  session: ProjectionSessionRow,
  metadata: Record<string, unknown> | null,
  links: SqliteArtifactLinkRow[],
  pullRequests: SqlitePullRequestRow[],
  counts: CountRow,
  viewedByUser: boolean,
  lastActivityAt: string | null
): Promise<SessionListTraceProjection> {
  const eventRows: SqliteEventRow[] = [];
  for await (const page of eventPages(reader, session.id)) {
    eventRows.push(...page);
  }
  const tokenEvents = await readLegacyTokenEvents(reader, session.id);
  const timeline = buildTraceTimelineRows(metadata, eventRows);
  const traceTokens = mapTraceTokenEvents(session.id, tokenEvents);
  const endMs = resolveTraceEndMs({
    updatedAt: session.updated_at,
    endedAt: session.ended_at,
    timelineRows: timeline,
    tokenEvents: traceTokens,
  });
  const fields = buildSessionTraceSyncFields({
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    endedAt: session.ended_at,
    metadata,
    attribution: null,
    artifactLinkBranch: resolveArtifactLinkBranch(links),
    events: eventRows,
    timelineRows: timeline,
    tokenEvents: traceTokens,
    localPullRequests: pullRequests,
    viewedByUser,
  });
  const artifactMarkers = createArtifactSessionMarkerAccumulator({
    startedAt: session.started_at,
    updatedAt: session.updated_at,
    endedAt: session.ended_at,
    endMs,
    links,
  });
  timeline.forEach((row, index) => {
    artifactMarkers.observeTimelineRow(row.createdAt, index);
  });
  const markers = mergeSessionMarkers(
    fields.markers ?? [],
    artifactMarkers.finish()
  ).slice(0, SESSION_TRACE_SOURCE_LIMITS.markers);
  return {
    agentCount: Number(counts.agent_count),
    errorCount: Number(counts.error_count),
    lastActivityAt,
    toolUseCount: Number(counts.tool_use_count),
    fields: {
      ...fields,
      ...(markers.length > 0 ? { markers } : {}),
      prRefs: buildPrRefs(links),
    },
  };
}
