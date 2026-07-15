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
  SESSION_TRACE_SOURCE_LIMITS,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
  SessionTraceThrottleSourceType,
  sessionPrWithLifecycle,
} from "@repo/api/src/session-trace/derivation";
import { isHeadlessSession } from "@repo/api/src/session-trace/headless";
import { MAX_SYNCED_SESSION_PR_REFS } from "@repo/api/src/types/session-artifact-link";
import { computeSessionTiming } from "../../shared/session-timing.js";
import { estimateTokenCost } from "../../shared/token-cost.js";
import { asRecord } from "../../shared/type-guards.js";
import type {
  ActivityBucket,
  SessionMarker,
  SessionPR,
  SessionTraceCorrectionSource,
  SessionTracePhaseSource,
  SessionTraceThrottleSource,
  SyncedAgentSession,
} from "../agent-session-sync-contract.js";
import { parseJsonValueText } from "../agent-session-sync-service.js";
import { parseIsoMs, roundNumber } from "../session-marker-utils.js";
import { reportTokenCostPricingMiss } from "../token-cost-pricing-miss.js";
import { BRANCH_WRITE_METHOD_VALUES } from "./db-constants.js";
import { nullableNumber, tokenCountValue } from "./db-helpers.js";
import type {
  SessionPrWithIdentity,
  SqliteArtifactLinkRow,
  SqliteGitLocRow,
  SqlitePullRequestRow,
} from "./db-row-types.js";

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
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: readonly {
    model: string;
    created_at: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd_estimated: number | null;
    input_cost_usd_estimated: number | null;
    output_cost_usd_estimated: number | null;
    cache_read_cost_usd_estimated: number | null;
    cache_creation_cost_usd_estimated: number | null;
  }[];
  localPullRequests: readonly SqlitePullRequestRow[];
};

type TraceTimelineRow = {
  eventType: string;
  toolName: string | null;
  createdAt: string;
  label: string;
};

function buildDiffStats(
  row: SqliteGitLocRow | undefined,
  field: "gitDiffStats" | "branchDiffStats"
): Partial<SyncedAgentSession> {
  if (!row) {
    return {};
  }
  const added = Number(row.total_added);
  const removed = Number(row.total_removed);
  const files = Number(row.total_files);
  if (added === 0 && removed === 0 && files === 0) {
    return {};
  }
  const stats: Partial<SyncedAgentSession> = {};
  stats[field] = {
    linesAdded: added,
    linesRemoved: removed,
    filesChanged: files,
    source: "git",
  };
  return stats;
}

// Write evidence only — a read-only session resolves to no branch.
const BRANCH_WRITE_METHODS: ReadonlySet<string> = new Set(
  BRANCH_WRITE_METHOD_VALUES
);

function resolveArtifactLinkBranch(
  linkRows: SqliteArtifactLinkRow[]
): string | null {
  let best: SqliteArtifactLinkRow | null = null;
  for (const link of linkRows) {
    if (link.target_kind !== "branch" || !link.branch_name) {
      continue;
    }
    if (!BRANCH_WRITE_METHODS.has(link.method)) {
      continue;
    }
    if (
      !best ||
      (link.link_observed_at ?? "") > (best.link_observed_at ?? "")
    ) {
      best = link;
    }
  }
  return best?.branch_name ?? null;
}

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
  } = input;
  const diffStats = asRecord(metadata?.diffStats);
  // FEA-1899: PRs come exclusively from artifact links (relation-aware).
  // The legacy metadata.artifacts.prs path is intentionally removed — it
  // carries "referenced" PRs (e.g. URLs in Read output) that aren't the
  // session's own work. Only 'created' and 'workspace' relations surface.
  // FEA-2711: cap the legacy `prs` field to the same shared per-session bound
  // the cloud enforces (`.max(MAX_SYNCED_SESSION_PR_REFS)`) and that the sibling
  // `prRefs` array is sliced to in `sync-source.ts`. Cap AFTER dedup so the
  // bound counts distinct PRs the way the cloud does; `mergeSessionPullRequests`
  // preserves oldest-first order, so this keeps the earliest N — matching the
  // `prRefs` "keep the earliest N" semantics. Without this, a session with more
  // than the cap of distinct PRs still fails cloud validation and stalls sync.
  const prs = mergeSessionPullRequests([
    ...localPullRequests.flatMap(localPullRequestToSessionPr),
  ]).slice(0, MAX_SYNCED_SESSION_PR_REFS);
  const turns =
    numberFromMetadata(metadata?.userMessages) +
    numberFromMetadata(metadata?.assistantMessages);
  const durationFields = buildTraceDurationFields({
    startedAt,
    updatedAt,
    endedAt,
    timelineRows,
  });
  const activityFields = buildTraceActivityFields({
    startedAt,
    updatedAt,
    endedAt,
    timelineRows,
    tokenEvents,
  });
  const promptTimestamps = timelineRows
    .filter((row) => row.eventType === "UserMessage")
    .map((row) => row.createdAt);
  const activityTimestamps = [
    ...timelineRows.map((row) => row.createdAt),
    ...tokenEvents.map((event) => event.created_at),
  ];
  const sourceFields = fitSessionTraceSourcesToAggregateLimit({
    tracePhaseSources: extractTracePhaseSources(events),
    throttleSources: extractThrottleSources(events),
    correctionSources: extractCorrectionSources(events),
  });
  // FEA-2870: the harness calling params (persisted in metadata at ingest) mark a
  // headless/autonomous run — asserted as fully agentic regardless of its lone
  // prompt episode.
  const headless = isHeadlessSession({
    entrypoint: stringFromMetadata(metadata?.entrypoint),
    permissionMode: stringFromMetadata(metadata?.permissionMode),
  });
  const presentation = deriveSessionTracePresentation({
    startedAt,
    updatedAt,
    endedAt,
    promptTimestamps,
    activityTimestamps,
    phaseSources: sourceFields.tracePhaseSources,
    throttleSources: sourceFields.throttleSources,
    correctionSources: sourceFields.correctionSources,
    headless,
  });
  const markers = [
    ...(activityFields.markers ?? []),
    ...presentation.correctionMarkers,
  ];

  return {
    // Emitted unconditionally so a read-only session (null) heals a stale
    // cloud branch rather than preserving the omitted field (AC8).
    branch: artifactLinkBranch ?? null,
    ...(prs.length > 0 ? { prs } : {}),
    ...durationFields,
    ...activityFields,
    ...(diffStats?.linesAdded === undefined
      ? {}
      : { linesAdded: numberFromMetadata(diffStats.linesAdded) }),
    ...(diffStats?.linesRemoved === undefined
      ? {}
      : { linesRemoved: numberFromMetadata(diffStats.linesRemoved) }),
    ...(diffStats?.filesChanged === undefined
      ? {}
      : { filesChanged: numberFromMetadata(diffStats.filesChanged) }),
    ...(turns > 0 ? { turns } : {}),
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
    rows.push({
      eventType: traceMessageEventType(role),
      toolName: null,
      createdAt: timestamp,
      label:
        role === "human"
          ? "Prompt"
          : (stringFromMetadata(message?.model) ?? role),
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
      const startedAt = validSourceDate(
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
      const observedAt = validSourceDate(
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
      const observedAt = validSourceDate(
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

function validSourceDate(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function optionalValidSourceDate(value: unknown): string | null | undefined {
  const text = stringFromMetadata(value);
  if (!text) {
    return null;
  }
  return validSourceDate(text) ?? undefined;
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

function buildTraceDurationFields(input: {
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  timelineRows: readonly TraceTimelineRow[];
}): Pick<SyncedAgentSession, "activeAgent" | "waitingUser" | "wallClock"> {
  const startMs = parseIsoMs(input.startedAt);
  const endMs = parseIsoMs(input.endedAt ?? input.updatedAt);
  const fields: Pick<
    SyncedAgentSession,
    "activeAgent" | "waitingUser" | "wallClock"
  > = {};
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
    fields.wallClock = formatTraceDuration(endMs - startMs);
  }
  const timingRows = input.timelineRows.map((row) => ({
    eventType: row.eventType,
    createdAt: row.createdAt,
  }));
  const timing = computeSessionTiming(timingRows);
  if (timing.activeAgentMs > 0) {
    fields.activeAgent = formatTraceDuration(timing.activeAgentMs);
  }
  if (timing.waitingUserMs > 0) {
    fields.waitingUser = `${formatTraceDuration(timing.waitingUserMs)} idle`;
  }
  return fields;
}

function buildTraceActivityFields(input: {
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  timelineRows: readonly TraceTimelineRow[];
  tokenEvents: SessionTraceSyncInput["tokenEvents"];
}): Pick<SyncedAgentSession, "activityBuckets" | "markers" | "span"> {
  const startMs = parseIsoMs(input.startedAt);
  const endMs = parseIsoMs(input.endedAt ?? input.updatedAt);
  if (
    !(Number.isFinite(startMs) && Number.isFinite(endMs)) ||
    endMs < startMs
  ) {
    return {};
  }
  const durationMs = Math.max(1, endMs - startMs);
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
    (_, index) => ({
      label: formatTraceClockOffset(Math.round(index * bucketMs)),
      cIn: 0,
      cOut: 0,
      cCache: 0,
      total: 0,
      toolStart: 0,
      tl0: null,
      byModel: {},
    })
  );

  input.timelineRows.forEach((row, index) => {
    const bucket =
      buckets[bucketIndex(row.createdAt, startMs, bucketMs, bucketCount)];
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
        bucketIndex(tokenEvent.created_at, startMs, bucketMs, bucketCount)
      ];
    if (!bucket) {
      continue;
    }
    const storedInputCost = nullableNumber(tokenEvent.input_cost_usd_estimated);
    const storedOutputCost = nullableNumber(
      tokenEvent.output_cost_usd_estimated
    );
    const storedCacheReadCost = nullableNumber(
      tokenEvent.cache_read_cost_usd_estimated
    );
    const storedCacheCreationCost = nullableNumber(
      tokenEvent.cache_creation_cost_usd_estimated
    );
    const inputTokens = tokenCountValue(
      tokenEvent.input_tokens,
      "timeline.input"
    );
    const outputTokens = tokenCountValue(
      tokenEvent.output_tokens,
      "timeline.output"
    );
    const cacheReadTokens = tokenCountValue(
      tokenEvent.cache_read_tokens,
      "timeline.cache_read"
    );
    const cacheWriteTokens = tokenCountValue(
      tokenEvent.cache_write_tokens,
      "timeline.cache_write"
    );
    const fallbackInput =
      storedInputCost == null &&
      storedOutputCost == null &&
      storedCacheReadCost == null &&
      storedCacheCreationCost == null
        ? {
            model: tokenEvent.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            observedAt: tokenEvent.created_at,
          }
        : undefined;
    const fallbackCost = fallbackInput
      ? estimateTokenCost(fallbackInput)
      : undefined;
    if (fallbackInput && !fallbackCost) {
      reportTokenCostPricingMiss(fallbackInput, "trace_activity");
    }
    const inputCost = storedInputCost ?? fallbackCost?.inputCostUsd ?? 0;
    const outputCost = storedOutputCost ?? fallbackCost?.outputCostUsd ?? 0;
    const cacheCost =
      (storedCacheReadCost ?? 0) +
      (storedCacheCreationCost ?? 0) +
      (fallbackCost?.cacheReadCostUsd ?? 0) +
      (fallbackCost?.cacheWriteCostUsd ?? 0);
    bucket.cIn += inputCost;
    bucket.cOut += outputCost;
    bucket.cCache += cacheCost;
    const byModel = bucket.byModel[tokenEvent.model] ?? {
      cIn: 0,
      cOut: 0,
      cCache: 0,
    };
    byModel.cIn += inputCost;
    byModel.cOut += outputCost;
    byModel.cCache += cacheCost;
    bucket.byModel[tokenEvent.model] = byModel;
  }

  const markers = buildTraceMarkers(input.timelineRows, startMs, durationMs);
  return {
    activityBuckets: buckets.map(roundActivityBucket),
    span: {
      first: formatTraceClockOffset(0),
      last: formatTraceClockOffset(durationMs),
    },
    ...(markers.length > 0 ? { markers } : {}),
  };
}

function buildTraceMarkers(
  rows: readonly TraceTimelineRow[],
  startMs: number,
  durationMs: number
): SessionMarker[] {
  return rows.flatMap((row, index): SessionMarker[] => {
    const kind = traceMarkerKind(row);
    if (!kind) {
      return [];
    }
    const rowMs = parseIsoMs(row.createdAt);
    const x = Number.isFinite(rowMs)
      ? Math.max(0, Math.min(100, ((rowMs - startMs) / durationMs) * 100))
      : 0;
    return [
      {
        kind,
        x: roundNumber(x),
        t: Number.isFinite(rowMs)
          ? formatTraceClockOffset(rowMs - startMs)
          : row.createdAt,
        label: clampMarkerLabel(row.label),
        tl: index,
      },
    ];
  });
}

function traceMarkerKind(row: TraceTimelineRow): SessionMarker["kind"] | null {
  const eventType = row.eventType.toLowerCase();
  const label = row.label.toLowerCase();
  if (eventType.includes("user") || eventType.includes("prompt")) {
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

function formatTraceDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatTraceClockOffset(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function bucketIndex(
  createdAt: string,
  startMs: number,
  bucketMs: number,
  bucketCount: number
): number {
  const eventMs = parseIsoMs(createdAt);
  if (!Number.isFinite(eventMs)) {
    return 0;
  }
  const index = Math.floor((eventMs - startMs) / bucketMs);
  return Math.max(0, Math.min(bucketCount - 1, index));
}

function roundActivityBucket(bucket: ActivityBucket): ActivityBucket {
  const byModel = Object.fromEntries(
    Object.entries(bucket.byModel).map(([model, costs]) => [
      model,
      {
        cIn: roundCostNumber(costs.cIn),
        cOut: roundCostNumber(costs.cOut),
        cCache: roundCostNumber(costs.cCache),
      },
    ])
  );
  return {
    ...bucket,
    cIn: roundCostNumber(bucket.cIn),
    cOut: roundCostNumber(bucket.cOut),
    cCache: roundCostNumber(bucket.cCache),
    byModel,
  };
}

function roundCostNumber(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function stringFromMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberFromMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberFromMetadata(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
        prState: row.state,
        closedAt: row.closed_at,
        mergedAt: row.merged_at,
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

export type { SessionTraceSyncInput };
export {
  buildDiffStats,
  buildSessionTraceSyncFields,
  buildTraceTimelineRows,
  resolveArtifactLinkBranch,
};
