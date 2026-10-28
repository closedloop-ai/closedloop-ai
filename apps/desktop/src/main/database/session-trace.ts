/**
 * @file session-trace.ts
 * @description Session-trace presentation builders for the desktop store — the
 * pure functions that derive a session's sync-trace fields, timeline rows,
 * duration/activity buckets, phase/throttle/correction sources, and PR/issue
 * markers from raw event and metadata rows. Extracted verbatim from `sqlite.ts`:
 * these carry no Prisma/database handle and depend only on shared helpers, the
 * row-type shapes, and the cross-runtime session-trace contract.
 */

import {
  clampMarkerLabel,
  deriveSessionTracePresentation,
  isSessionTerminatingLabel,
  resolveActivityEndMs,
  SESSION_TRACE_SOURCE_LIMITS,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
  sessionPrWithLifecycle,
} from "@repo/lib/session-trace/derivation";
import { sessionHasParsedTranscript } from "@repo/lib/session-trace/transcript";
import { asRecord } from "../../shared/type-guards.js";
import type {
  ActivityBucket,
  SessionMarker,
  SessionPR,
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
  SyncedAgentSession,
} from "../agent-sync/agent-session-sync-contract.js";
import { parseJsonValueText } from "../agent-sync/agent-sync-json-text.js";
import { parseIsoMs, roundNumber } from "../session/session-marker-utils.js";
import { validIso } from "./db-helpers.js";
import type {
  SessionPrWithIdentity,
  SqlitePullRequestRow,
} from "./db-row-types.js";
import {
  createActivityBucket,
  roundActivityBucket,
} from "./session-trace-activity-bucket.js";
import {
  activityExtentMs,
  bucketIndex,
  clampToRange,
  formatTraceClockOffset,
} from "./session-trace-activity-geometry.js";
import { buildSessionAutonomyInputFromTrace } from "./session-trace-autonomy-input.js";
import { buildTraceDurationFields } from "./session-trace-duration.js";
import {
  boundedLocFromMetadata,
  boundedTurnsFromMetadata,
  optionalNumberFromMetadata,
} from "./session-trace-metadata-values.js";
import { addTraceTokenEventToBucket } from "./session-trace-token-bucket.js";

const SESSION_TRACE_BUCKET_TARGET = 40;
const SESSION_TRACE_PHASE_EVENT_RE =
  /(^|[._:-])(loop\.perf\.phase|session[_:. -]?trace[_:. -]?phase|trace[_:. -]?phase|phase)([._:-]|$)/i;
const SESSION_TRACE_THROTTLE_EVENT_RE =
  /(^|[._:-])(session[_:. -]?trace[_:. -]?throttle|trace[_:. -]?throttle|provider[_:. -]?rate[_:. -]?limit|rate[_:. -]?limit|usage[_:. -]?limit|throttle)([._:-]|$)/i;
const SESSION_TRACE_CORRECTION_EVENT_RE =
  /(^|[._:-])(session[_:. -]?trace[_:. -]?correction|trace[_:. -]?correction|manual[_:. -]?regression|change[_:. -]?request|review[_:. -]?requested[_:. -]?changes|approval[_:. -]?denied|negative[_:. -]?feedback|correction)([._:-]|$)/i;

type SessionTraceSyncInput = {
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  metadata: Record<string, unknown> | null;
  attribution: { baseBranch?: string | null } | null | undefined;
  artifactLinkBranch: string | null;
  events: readonly {
    event_type: string;
    tool_name: string | null;
    created_at: string;
    summary?: string | null;
    data?: string | null;
  }[];
  /**
   * ISS-7830: whether a user ever navigated into this thread. Read from
   * `session_viewership`, never from `metadata` — the importer rewrites that blob
   * from the transcript on every re-import. Absent means unviewed, which is the
   * pre-ISS-7830 classification.
   */
  viewedByUser?: boolean;
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: readonly {
    model: string;
    created_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    /** FEA-3419: optional TTL split for 1h-correct fallback pricing. */
    cache_write_5m_tokens?: number | null;
    cache_write_1h_tokens?: number | null;
    cost_usd_estimated: number | null;
    input_cost_usd_estimated: number | null;
    output_cost_usd_estimated: number | null;
    cache_read_cost_usd_estimated: number | null;
    cache_creation_cost_usd_estimated: number | null;
  }[];
  localPullRequests: readonly SqlitePullRequestRow[];
};

export type TraceTimelineRow = {
  eventType: string;
  toolName: string | null;
  createdAt: string;
  label: string;
  /**
   * ISS-8659: this row is a Claude `/fork` child's replay of a PARENT message.
   * It still RENDERS — the inherited conversation is the capability the ticket
   * chose to keep — but it is not this session's own steering, so it earns no
   * `prompt` marker and no autonomy prompt. Kept as a flag rather than a distinct
   * `eventType` so row ordering and `eventRole` classification are untouched.
   */
  isForkReplayed?: boolean;
};

function buildSessionTraceSyncFields(
  input: SessionTraceSyncInput
): Partial<SyncedAgentSession> {
  const {
    startedAt,
    updatedAt,
    endedAt,
    metadata,
    artifactLinkBranch,
    events,
    timelineRows,
    tokenEvents,
    localPullRequests,
    viewedByUser,
  } = input;
  const diffStats = asRecord(metadata?.diffStats);
  // FEA-3267: these flat scalars land in int4 SessionDetail columns that the
  // cloud wire schema bounds, so clamp the harness-supplied metadata.
  // An out-of-int4 (or negative/fractional) value would otherwise fail the
  // cloud's single batch parse and reject every session in it — drop the field,
  // not the sync.
  const flatLinesAdded = boundedLocFromMetadata(diffStats?.linesAdded);
  const flatLinesRemoved = boundedLocFromMetadata(diffStats?.linesRemoved);
  const flatFilesChanged = boundedLocFromMetadata(diffStats?.filesChanged);
  // FEA-1899: PRs come exclusively from artifact links (relation-aware).
  // The legacy metadata.artifacts.prs path is intentionally removed — it
  // carried noise. 'created' and 'workspace' relations surface, plus
  // FEA-2806: harness pr-link records (method 'harness_pr_link') are
  // included — those are PRs the session actively worked with. Tool-text
  // URL matches ('pr_url_in_tool_use') remain excluded as noise.
  // ISS-9859: emitted whole, like the sibling `prRefs` in `sync-source.ts`. The
  // two used to share a 100-ref producer cap that kept the EARLIEST PRs.
  const prs = mergeSessionPullRequests([
    ...localPullRequests.flatMap(localPullRequestToSessionPr),
  ]);
  const turns = boundedTurnsFromMetadata(
    metadata?.userMessages,
    metadata?.assistantMessages
  );
  // FEA-3427 + ISS-5182: one end anchor for both duration and timeline. A
  // terminal session's `endedAt` is itself `max(event.created_at)` frozen at the
  // terminal transition (`session-maintenance.ts`, FEA-3580), so it IS the
  // activity end — and unlike `last_activity_at`, which keeps being recomputed
  // at ingest afterwards, it cannot drift past the session's real end.
  const startMs = parseIsoMs(startedAt);
  const traceEndInput = { updatedAt, endedAt, timelineRows, tokenEvents };
  const activityEndMs = resolveTraceEndMs(traceEndInput);
  const durationFields = buildTraceDurationFields({
    startMs,
    endMs: activityEndMs,
    timelineRows,
  });
  const activityFields = buildTraceActivityFields({
    startMs,
    endMs: activityEndMs,
    timelineRows,
    tokenEvents,
    // FEA-3671: gate human prompt markers on the human-turn SSOT — a parsed
    // transcript's `role:"human"` (UserMessage) rows are authoritative; when one
    // exists, hook `UserPromptSubmit` events do NOT emit prompt markers (they
    // aren't counted as human turns either).
    hasTranscript: sessionHasParsedTranscript(metadata),
  });
  const sourceFields = fitSessionTraceSourcesToAggregateLimit({
    tracePhaseSources: extractTracePhaseSources(events),
    throttleSources: extractThrottleSources(events),
    correctionSources: extractCorrectionSources(events),
  });
  const autonomyInput = buildSessionAutonomyInputFromTrace(
    metadata,
    timelineRows,
    tokenEvents,
    viewedByUser
  );
  const presentation = deriveSessionTracePresentation({
    startedAt,
    updatedAt,
    endedAt,
    // FEA-3427: anchor correction/throttle marker coordinates to the corrected
    // end (last real activity), matching the activity buckets/span — not the
    // days-long re-sync-bumped updated_at window.
    ...(Number.isFinite(activityEndMs) ? { endMs: activityEndMs } : {}),
    ...autonomyInput,
    phaseSources: sourceFields.tracePhaseSources,
    throttleSources: sourceFields.throttleSources,
    correctionSources: sourceFields.correctionSources,
  });
  const markers = [
    ...(activityFields.markers ?? []),
    ...presentation.correctionMarkers,
  ];

  return {
    // Legacy sync field for server skew; modern cloud derives session-to-branch
    // association from artifact links, like desktop local display.
    branch: artifactLinkBranch ?? null,
    ...(prs.length > 0 ? { prs } : {}),
    ...durationFields,
    ...activityFields,
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
    tracePhaseSources: sourceFields.tracePhaseSources,
    throttleSources: sourceFields.throttleSources,
    correctionSources: sourceFields.correctionSources,
    phases: presentation.phases,
    phaseIterations: presentation.phaseIterations,
    phaseLoopbacks: presentation.phaseLoopbacks,
    throttles: presentation.throttles,
    markers,
  };
}

function buildTraceTimelineRows(
  metadata: Record<string, unknown> | null,
  events: SessionTraceSyncInput["events"]
): TraceTimelineRow[] {
  const rows: TraceTimelineRow[] = [];
  const terminatingCommandsByTimestamp = buildTerminatingCommandMap(metadata);
  const rawMessages = Array.isArray(metadata?.messages)
    ? metadata.messages
    : [];
  for (const rawMessage of rawMessages) {
    const message = asRecord(rawMessage);
    const timestamp = stringFromMetadata(message?.timestamp);
    const role = stringFromMetadata(message?.role);
    if (!(timestamp && role)) {
      continue;
    }
    let label: string;
    if (role === "human") {
      label = terminatingCommandsByTimestamp.get(timestamp) ?? "Prompt";
    } else {
      label = stringFromMetadata(message?.model) ?? role;
    }
    rows.push({
      eventType: traceMessageEventType(role),
      toolName: null,
      createdAt: timestamp,
      label,
      ...(message?.isForkReplayed === true ? { isForkReplayed: true } : {}),
    });
  }
  for (const event of events) {
    rows.push({
      eventType: event.event_type,
      toolName: event.tool_name,
      createdAt: event.created_at,
      label: event.tool_name ?? event.summary ?? event.event_type,
    });
  }
  // Decorate-sort-undecorate: precompute the sort keys once per row so the
  // comparator does O(1) work instead of re-running parseIsoMs (a Date.parse)
  // on both operands for every one of the ~N·log₂N comparisons.
  return rows
    .map((row) => ({
      row,
      ms: parseIsoMs(row.createdAt),
      order: traceRowOrder(row),
    }))
    .sort((left, right) => {
      const byTime = left.ms - right.ms;
      if (byTime !== 0) {
        return byTime;
      }
      return left.order - right.order;
    })
    .map((decorated) => decorated.row);
}

function traceMessageEventType(role: string): string {
  if (role === "human") {
    return "UserMessage";
  }
  if (role === "assistant") {
    return "AssistantMessage";
  }
  return "SystemMessage";
}

function extractTracePhaseSources(
  events: SessionTraceSyncInput["events"]
): SessionTracePhaseSource[] {
  return events
    .flatMap((event): SessionTracePhaseSource[] => {
      const data = asRecord(parseJsonValueText(event.data ?? null));
      const eventType = event.event_type.toLowerCase();
      if (!SESSION_TRACE_PHASE_EVENT_RE.test(eventType)) {
        return [];
      }
      const phaseKey =
        sourceTextFromMetadata(data?.phaseKey) ??
        sourceTextFromMetadata(data?.phase) ??
        sourceTextFromMetadata(data?.name);
      const label = sourceTextFromMetadata(data?.label) ?? phaseKey;
      const startedAt = validIso(
        stringFromMetadata(data?.startedAt) ?? event.created_at
      );
      const endedAt = optionalValidSourceDate(data?.endedAt);
      if (!(phaseKey && label && startedAt) || endedAt === undefined) {
        return [];
      }
      return [
        {
          sourceType: eventType.includes("loop.perf")
            ? SessionTracePhaseSourceType.LoopPerf
            : SessionTracePhaseSourceType.Explicit,
          phaseKey,
          label,
          startedAt,
          endedAt,
        },
      ];
    })
    .slice(0, SESSION_TRACE_SOURCE_LIMITS.phaseSources);
}

function extractThrottleSources(
  events: SessionTraceSyncInput["events"]
): SessionTraceThrottleSource[] {
  return events
    .flatMap((event): SessionTraceThrottleSource[] => {
      const data = asRecord(parseJsonValueText(event.data ?? null));
      const eventType = event.event_type.toLowerCase();
      if (!SESSION_TRACE_THROTTLE_EVENT_RE.test(eventType)) {
        return [];
      }
      const statusCode = optionalNumberFromMetadata(data?.statusCode);
      const provider =
        sourceTextFromMetadata(data?.provider) ??
        sourceTextFromMetadata(data?.service) ??
        "unknown";
      const observedAt = validIso(
        stringFromMetadata(data?.observedAt) ?? event.created_at
      );
      const resetAt = optionalValidSourceDate(data?.resetAt);
      if (!(provider && observedAt) || resetAt === undefined) {
        return [];
      }
      return [
        {
          sourceType: throttleSourceType(eventType, statusCode, data),
          provider,
          observedAt,
          limitKind: sourceTextFromMetadata(data?.limitKind ?? data?.type),
          statusCode: statusCode ?? null,
          errorCode: sourceTextFromMetadata(data?.errorCode ?? data?.code),
          resetAt,
          retryAfterSeconds: optionalNumberFromMetadata(
            data?.retryAfterSeconds
          ),
        },
      ];
    })
    .slice(0, SESSION_TRACE_SOURCE_LIMITS.throttleSources);
}

function throttleSourceType(
  eventType: string,
  statusCode: number | null,
  data: Record<string, unknown> | null
): SessionTraceThrottleSource["sourceType"] {
  if (eventType.includes("usage_limit")) {
    return SessionTraceThrottleSourceType.UsageLimit;
  }
  if (statusCode === 429) {
    return SessionTraceThrottleSourceType.ApiError;
  }
  if (data?.rate_limits) {
    return SessionTraceThrottleSourceType.TokenSnapshot;
  }
  return SessionTraceThrottleSourceType.ProviderRateLimit;
}

function extractCorrectionSources(
  events: SessionTraceSyncInput["events"]
): SessionTraceCorrectionSource[] {
  return events
    .flatMap((event): SessionTraceCorrectionSource[] => {
      const data = asRecord(parseJsonValueText(event.data ?? null));
      const kind = correctionKind(event.event_type, data);
      const observedAt = validIso(
        stringFromMetadata(data?.observedAt) ?? event.created_at
      );
      const sourceType = sourceTextFromMetadata(event.event_type);
      if (!kind) {
        return [];
      }
      if (!(observedAt && sourceType)) {
        return [];
      }
      return [
        {
          kind,
          observedAt,
          label:
            sourceTextFromMetadata(event.summary) ??
            sourceTextFromMetadata(data?.label) ??
            kind,
          sourceType,
        },
      ];
    })
    .slice(0, SESSION_TRACE_SOURCE_LIMITS.correctionSources);
}

function correctionKind(
  eventType: string,
  data: Record<string, unknown> | null | undefined
): SessionTraceCorrectionSource["kind"] | null {
  const normalized = eventType.toLowerCase();
  if (!SESSION_TRACE_CORRECTION_EVENT_RE.test(normalized)) {
    return null;
  }
  const rawKind = stringFromMetadata(data?.kind)?.toLowerCase();
  if (
    normalized.includes("manual_regression") ||
    rawKind === "manual_regression"
  ) {
    return SessionTraceCorrectionKind.ManualRegression;
  }
  if (
    normalized.includes("change_request") ||
    normalized.includes("review_requested_changes") ||
    rawKind === "review_change_request"
  ) {
    return SessionTraceCorrectionKind.ReviewChangeRequest;
  }
  if (normalized.includes("approval_denied") || rawKind === "approval_denied") {
    return SessionTraceCorrectionKind.ApprovalDenied;
  }
  if (
    normalized.includes("negative_feedback") ||
    rawKind === "negative_feedback"
  ) {
    return SessionTraceCorrectionKind.NegativeFeedback;
  }
  if (normalized.includes("correction") || rawKind === "explicit_correction") {
    return SessionTraceCorrectionKind.ExplicitCorrection;
  }
  return null;
}

function sourceTextFromMetadata(value: unknown): string | null {
  const text = stringFromMetadata(value);
  if (!text) {
    return null;
  }
  return text.slice(0, SESSION_TRACE_SOURCE_LIMITS.sourceText);
}

function optionalValidSourceDate(value: unknown): string | null | undefined {
  const text = stringFromMetadata(value);
  if (!text) {
    return null;
  }
  return validIso(text) ?? undefined;
}

function fitSessionTraceSourcesToAggregateLimit(input: {
  tracePhaseSources: SessionTracePhaseSource[];
  throttleSources: SessionTraceThrottleSource[];
  correctionSources: SessionTraceCorrectionSource[];
}): {
  tracePhaseSources: SessionTracePhaseSource[];
  throttleSources: SessionTraceThrottleSource[];
  correctionSources: SessionTraceCorrectionSource[];
} {
  const output = {
    tracePhaseSources: [...input.tracePhaseSources],
    throttleSources: [...input.throttleSources],
    correctionSources: [...input.correctionSources],
  };
  while (
    Buffer.byteLength(JSON.stringify(output)) >
    SESSION_TRACE_SOURCE_LIMITS.aggregatePayloadBytes
  ) {
    if (output.correctionSources.pop()) {
      continue;
    }
    if (output.throttleSources.pop()) {
      continue;
    }
    if (output.tracePhaseSources.pop()) {
      continue;
    }
    break;
  }
  return output;
}

// FEA-3427: resolve the wall-clock END anchor for a session.
//
// A genuinely-ended session (ended_at present) anchors to ended_at — unchanged.
// For an open / long-lived session (ended_at null) we must NOT fall back to the
// mutable `updated_at`: it is bumped on every touch/re-sync (OTEL ingest,
// enrichment, sync writes) and can sit days-to-weeks past the last real
// activity, so wall-clock ends up measuring calendar drift ("~480h" / "20 days")
// rather than the session's activity span. Instead anchor to the LAST real
// activity timestamp — the extent of the timeline/token-event stream (the same
// "genuine activity = latest agent event" principle as PLN-1034 in
// sync-source.ts). `updated_at` is used only as a last resort when the session
// carries no activity timestamps at all.
function resolveTraceEndMs(input: {
  updatedAt: string;
  endedAt: string | null;
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: SessionTraceSyncInput["tokenEvents"];
}): number {
  return resolveActivityEndMs({
    endedAt: input.endedAt,
    updatedAt: input.updatedAt,
    activityTimestamps: traceActivityTimestamps(input),
  });
}

function* traceActivityTimestamps(input: {
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: SessionTraceSyncInput["tokenEvents"];
}): Generator<string> {
  for (const row of input.timelineRows) {
    yield row.createdAt;
  }
  for (const event of input.tokenEvents) {
    yield event.created_at;
  }
}

function buildTraceActivityFields(input: {
  // FEA-3427: startMs/endMs are resolved once by buildSessionTraceSyncFields and
  // shared with buildTraceDurationFields — the corrected wall-clock end anchor
  // (last real activity extent for an open session, not the re-sync-bumped
  // updated_at) keeps the buckets/span/markers window consistent.
  startMs: number;
  endMs: number;
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: SessionTraceSyncInput["tokenEvents"];
  // FEA-3671: whether a parsed transcript exists (see sessionHasParsedTranscript).
  hasTranscript: boolean;
}): Pick<SyncedAgentSession, "activityBuckets" | "markers" | "span"> {
  const { startMs, endMs } = input;
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return {};
  }
  // FEA-3586: bucket/marker over the REAL activity extent, not the raw
  // [startedAt, endedAt/updatedAt] window. A stale or overshooting end anchor
  // (e.g. an `endedAt` set far past the last real event, or an orphan-swept
  // end) otherwise makes `durationMs` dwarf the active span, so every event's
  // `floor((eventMs - startMs) / bucketMs)` collapses into the first bucket(s)
  // — the timeline shows bars only for "the first hour" and renders idle
  // (cost 0) for everything after, which is exactly the reported symptom.
  // Tightening the window to [firstActivity, lastActivity] (clamped inside the
  // resolved [startMs, endMs]) spreads activity across the full bar strip and
  // keeps the green-dot markers, whose `x`/`tl` derive from this same window,
  // anchored to their true position. The wall-clock duration shown on the axis
  // is derived separately (`getDurationScaleMinutes`) and is unaffected.
  const { minMs: activityMinMs, maxMs: activityMaxMs } = activityExtentMs(
    input.timelineRows,
    input.tokenEvents
  );
  const windowStartMs = Number.isFinite(activityMinMs)
    ? clampToRange(activityMinMs, startMs, endMs)
    : startMs;
  const windowEndMs = Number.isFinite(activityMaxMs)
    ? clampToRange(activityMaxMs, windowStartMs, endMs)
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
  const buckets: ActivityBucket[] = Array.from(
    { length: bucketCount },
    (_, index) =>
      createActivityBucket({
        binEndMs: Math.round(windowStartMs + (index + 1) * bucketMs),
        binStartMs: Math.round(windowStartMs + index * bucketMs),
        label: formatTraceClockOffset(Math.round(index * bucketMs)),
      })
  );

  input.timelineRows.forEach((row, index) => {
    const bucket =
      buckets[bucketIndex(row.createdAt, windowStartMs, bucketMs, bucketCount)];
    if (!bucket) {
      return;
    }
    bucket.total += 1;
    if (row.toolName) {
      bucket.toolStart += 1;
    }
    bucket.tl0 ??= index;
  });

  for (const tokenEvent of input.tokenEvents) {
    const bucket =
      buckets[
        bucketIndex(tokenEvent.created_at, windowStartMs, bucketMs, bucketCount)
      ];
    if (!bucket) {
      continue;
    }
    addTraceTokenEventToBucket(bucket, tokenEvent);
  }

  const markers = buildTraceMarkers(
    input.timelineRows,
    windowStartMs,
    durationMs,
    input.hasTranscript
  );
  return {
    activityBuckets: buckets.map(roundActivityBucket),
    span: {
      first: formatTraceClockOffset(0),
      last: formatTraceClockOffset(durationMs),
      /*
       * ISS-5850: the ABSOLUTE extent the bins above tile, alongside the clock
       * offsets that describe the same two edges.
       *
       * `first`/`last` are offsets from `windowStartMs` and so carry no anchor,
       * which left every consumer unable to tell an interval this collector
       * never looked at from one it observed as quiet. The bins are laid down
       * across exactly `[windowStartMs, windowStartMs + durationMs]` a few lines
       * up — that is the extent, stated by the producer that measured it rather
       * than re-inferred downstream from the union of the bins it happened to
       * emit.
       *
       * `windowStartMs + durationMs`, NOT `windowEndMs` (#5921 review). They are
       * the same number for every session with any span at all, and differ on
       * exactly one input: a session whose every usable timeline row and token
       * event carries ONE timestamp. There `windowEndMs === windowStartMs`, but
       * `durationMs` is floored to 1ms so a strip can exist at all, and the sole
       * bin emitted therefore ends at `windowStartMs + 1`. Stating `windowEndMs`
       * would publish an extent one millisecond SHORT of the bin it describes,
       * so the consumer's overlap test (`resolveTimelineSourceExtent` →
       * `resolveColumnCoverage`) sees a bin sticking out past the extent that
       * produced it. The floor is part of the geometry, so the extent has to
       * carry it.
       */
      startMs: windowStartMs,
      endMs: windowStartMs + durationMs,
    },
    ...(markers.length > 0 ? { markers } : {}),
  };
}

function buildTraceMarkers(
  rows: readonly TraceTimelineRow[],
  startMs: number,
  durationMs: number,
  hasTranscript: boolean
): SessionMarker[] {
  return rows.flatMap((row, index) => {
    const marker = buildTraceMarker(
      row,
      index,
      startMs,
      durationMs,
      hasTranscript
    );
    return marker ? [marker] : [];
  });
}

/** Build one canonical activity marker without retaining its timeline. */
export function buildTraceMarker(
  row: TraceTimelineRow,
  index: number,
  startMs: number,
  durationMs: number,
  hasTranscript: boolean
): SessionMarker | null {
  const kind = traceMarkerKind(row, hasTranscript);
  if (!kind) {
    return null;
  }
  const rowMs = parseIsoMs(row.createdAt);
  const x = Number.isFinite(rowMs)
    ? Math.max(0, Math.min(100, ((rowMs - startMs) / durationMs) * 100))
    : 0;
  return {
    kind,
    x: roundNumber(x),
    t: Number.isFinite(rowMs)
      ? formatTraceClockOffset(rowMs - startMs)
      : row.createdAt,
    label: clampMarkerLabel(row.label),
    tl: index,
  };
}

function traceMarkerKind(
  row: TraceTimelineRow,
  hasTranscript: boolean
): SessionMarker["kind"] | null {
  const eventType = row.eventType.toLowerCase();
  const label = row.label.toLowerCase();
  // FEA-3671: a `prompt` marker means "human steering" and must agree with the
  // humanTurns count. When a parsed transcript exists, the human-turn SSOT is the
  // `role:"human"` message rows — tagged `eventType === "UserMessage"` by
  // buildTraceTimelineRows (the parser already dropped synthetic `isMeta` `/login`
  // entries) — MINUS the fork-replayed ones. Hook `UserPromptSubmit` events (also
  // `event_type` matching user/prompt) are NOT human turns in that regime, so they
  // must NOT emit a prompt marker — otherwise a meta-only `/login` session shows
  // prompt markers while humanTurns=0. Only a transcript-less (hook-only live)
  // session falls back to the broad user/prompt event-name match, exactly as the
  // human-turn rollup's COALESCE(transcript_human_turns, ht.human_turns) does.
  //
  // ISS-8659 narrowed the transcript arm: `$.messages` keeps a fork's replayed
  // parent prompts so the inherited conversation still renders, while
  // `transcriptHumanTurnsSql` counts only the fork's own. Without this exclusion
  // the designated fork dossier renders four prompt markers beside a stored
  // `human_turns` of 1 — the disagreement this comment exists to forbid.
  if (
    hasTranscript
      ? row.eventType === "UserMessage" && row.isForkReplayed !== true
      : eventType.includes("user") || eventType.includes("prompt")
  ) {
    if (isSessionTerminatingLabel(row.label)) {
      return null;
    }
    return "prompt";
  }
  if (eventType.includes("error") || eventType.includes("fail")) {
    return "fail";
  }
  if (eventType.includes("git") || label.includes("commit")) {
    return "commit";
  }
  if (label.includes("pull request") || label.includes("/pull/")) {
    return "pr";
  }
  return null;
}

function traceRowOrder(row: TraceTimelineRow): number {
  if (row.eventType === "UserMessage") {
    return 0;
  }
  if (row.eventType === "AssistantMessage") {
    return 1;
  }
  if (row.toolName) {
    return 2;
  }
  return 3;
}

function stringFromMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function localPullRequestToSessionPr(
  row: SqlitePullRequestRow
): SessionPrWithIdentity[] {
  if (row.pr_number == null) {
    return [];
  }
  return [
    {
      ...sessionPrWithLifecycle({
        num: row.pr_number,
        title: row.title,
        status: null,
        closedAt: row.closed_at,
      }),
      repositoryFullName: row.repo_full_name,
    },
  ];
}

function mergeSessionPullRequests(prs: SessionPrWithIdentity[]): SessionPR[] {
  const byIdentity = new Map<string, SessionPrWithIdentity>();
  for (const pr of prs) {
    const normalizedNumber = String(pr.num).trim();
    const identityKey = sessionPullRequestIdentityKey(
      pr.repositoryFullName,
      normalizedNumber
    );
    const legacyKey = sessionPullRequestIdentityKey(null, normalizedNumber);
    if (stringFromMetadata(pr.repositoryFullName)) {
      byIdentity.delete(legacyKey);
    } else if (hasRepositoryScopedSessionPr(byIdentity, normalizedNumber)) {
      continue;
    }
    byIdentity.set(identityKey, pr);
  }
  return [...byIdentity.values()].map(stripSessionPrIdentity);
}

function sessionPullRequestIdentityKey(
  repositoryFullName: string | null | undefined,
  prNumber: number | string
): string {
  const normalizedRepository =
    stringFromMetadata(repositoryFullName)?.toLowerCase();
  const normalizedNumber = String(prNumber).trim();
  return normalizedRepository
    ? `${normalizedRepository}#${normalizedNumber}`
    : `legacy#${normalizedNumber}`;
}

function hasRepositoryScopedSessionPr(
  prs: Map<string, SessionPrWithIdentity>,
  normalizedNumber: string
): boolean {
  for (const key of prs.keys()) {
    if (
      key !== `legacy#${normalizedNumber}` &&
      key.endsWith(`#${normalizedNumber}`)
    ) {
      return true;
    }
  }
  return false;
}

function stripSessionPrIdentity(pr: SessionPrWithIdentity): SessionPR {
  const { repositoryFullName: _repositoryFullName, ...sessionPr } = pr;
  return sessionPr;
}

function buildTerminatingCommandMap(
  metadata: Record<string, unknown> | null
): Map<string, string> {
  const map = new Map<string, string>();
  const rawCommands = Array.isArray(metadata?.slashCommands)
    ? metadata.slashCommands
    : [];
  for (const rawCommand of rawCommands) {
    const cmd = asRecord(rawCommand);
    const name = stringFromMetadata(cmd?.name);
    const timestamp = stringFromMetadata(cmd?.timestamp);
    if (name && timestamp && isSessionTerminatingLabel(name)) {
      map.set(timestamp, name);
    }
  }
  return map;
}

export type { SessionTraceSyncInput };
export {
  buildSessionTraceSyncFields,
  buildTraceTimelineRows,
  extractCorrectionSources,
  extractThrottleSources,
  fitSessionTraceSourcesToAggregateLimit,
  localPullRequestToSessionPr,
  mergeSessionPullRequests,
  resolveTraceEndMs,
  traceRowOrder,
};
