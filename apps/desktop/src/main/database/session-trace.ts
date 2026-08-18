/**
 * @file session-trace.ts
 * @description Session-trace presentation builders for the desktop store — the
 * pure functions that derive a session's sync-trace fields, timeline rows,
 * duration/activity buckets, phase/throttle/correction sources, and PR/issue
 * markers from raw event and metadata rows. Extracted verbatim from `sqlite.ts`:
 * these carry no Prisma/database handle and depend only on shared helpers, the
 * row-type shapes, and the cross-runtime session-trace contract.
 */

import { MAX_SYNCED_SESSION_PR_REFS_PRODUCER } from "@repo/api/src/types/session-artifact-link";
import {
  LOC_SOURCE_BRANCH_FALLBACK,
  LOC_SOURCE_GIT,
} from "@repo/api/src/utils/session-loc";
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
} from "../agent-sync/agent-session-sync-contract.js";
import { parseJsonValueText } from "../agent-sync/agent-sync-json-text.js";
import { reportTokenCostPricingMiss } from "../cost/token-cost-pricing-miss.js";
import { parseIsoMs, roundNumber } from "../session/session-marker-utils.js";
import { BRANCH_WRITE_METHOD_VALUES } from "./db-constants.js";
import {
  boundedNonNegativeInt,
  nullableNumber,
  tokenCountValue,
  validIso,
} from "./db-helpers.js";
import type {
  SessionPrWithIdentity,
  SqliteArtifactLinkRow,
  SqliteGitLocRow,
  SqlitePullRequestRow,
} from "./db-row-types.js";
import {
  createActivityBucket,
  roundActivityBucket,
} from "./session-trace-activity-bucket.js";
import { buildSessionAutonomyInput } from "./session-trace-autonomy-input.js";
import { buildTraceDurationFields } from "./session-trace-duration.js";

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
  // FEA-3267: these LOC land in the Postgres int4 columns
  // SessionDetail.lines_added/branch_lines_added, so route the summed SQLite
  // values through the same int4/PR_INT_MAX bound the cloud wire schema declares
  // (as the PR/commit-ref LOC path already does). An overflowed 64-bit SUM that
  // cleared a bare `=== 0` check would fail the cloud's single batch parse / int4
  // upsert and reject every session in the batch — omit the block, not the sync.
  const added = boundedNonNegativeInt(Number(row.total_added));
  const removed = boundedNonNegativeInt(Number(row.total_removed));
  const files = boundedNonNegativeInt(Number(row.total_files));
  if (added === undefined || removed === undefined || files === undefined) {
    return {};
  }
  if (added === 0 && removed === 0 && files === 0) {
    return {};
  }
  const stats: Partial<SyncedAgentSession> = {};
  stats[field] = {
    linesAdded: added,
    linesRemoved: removed,
    filesChanged: files,
    // FEA-3633: tag the AUTHORED (gitDiffStats) LOC as a branch/PR-total fallback
    // when the desktop query fell back to the branch/PR total (loc_basis =
    // 'branch_fallback') instead of the session's own authored-commit sums, so the
    // cloud can dedup that shared total per branch. Commit-sourced authored LOC and
    // the always-branch-total branchDiffStats field stay tagged "git".
    source: locSourceFor(field, row.loc_basis),
  };
  return stats;
}

/**
 * FEA-3633: the `source` tag for a diff-stats block. Only the authored
 * `gitDiffStats` field distinguishes the branch/PR-total fallback (loc_basis =
 * 'branch_fallback') from authored-commit LOC; the `branchDiffStats` field is the
 * branch total BY CONSTRUCTION, so it stays "git".
 */
function locSourceFor(
  field: "gitDiffStats" | "branchDiffStats",
  locBasis: string | null | undefined
): string {
  if (field === "gitDiffStats" && locBasis === LOC_SOURCE_BRANCH_FALLBACK) {
    return LOC_SOURCE_BRANCH_FALLBACK;
  }
  return LOC_SOURCE_GIT;
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
  // FEA-3267: these flat scalars land in the same int4 SessionDetail columns as
  // buildDiffStats()'s summed values and the cloud wire schema bounds them
  // identically, so route the harness-supplied metadata through the same clamp.
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
  // FEA-2711: cap the legacy `prs` field to the desktop PRODUCER per-session
  // bound (`MAX_SYNCED_SESSION_PR_REFS_PRODUCER`) that the sibling `prRefs` array
  // is also sliced to in `sync-source.ts`. Cap AFTER dedup so the bound counts
  // distinct PRs the way the cloud does; `mergeSessionPullRequests` preserves
  // oldest-first order, so this keeps the earliest N — matching the `prRefs`
  // "keep the earliest N" semantics.
  // ISS-4445: the producer bound stays 100 while the cloud validator accepts up
  // to 500, so a new desktop never emits a payload an old (`.max(100)`) cloud
  // would reject the whole batch over — the raise is deploy-order-safe. Both
  // sides still validate against the higher cloud cap.
  const prs = mergeSessionPullRequests([
    ...localPullRequests.flatMap(localPullRequestToSessionPr),
  ]).slice(0, MAX_SYNCED_SESSION_PR_REFS_PRODUCER);
  const turns =
    numberFromMetadata(metadata?.userMessages) +
    numberFromMetadata(metadata?.assistantMessages);
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
  // FEA-3781: the prompt/agent stream split and the headless signal, with their
  // rationale, live in ./session-trace-autonomy-input.ts.
  const autonomyInput = buildSessionAutonomyInput({
    entrypoint: stringFromMetadata(metadata?.entrypoint),
    // FEA-3671: the same transcript-first precedence the prompt markers use, so
    // the timeline, humanTurns, and autonomy cannot disagree on human turns.
    hasTranscript: sessionHasParsedTranscript(metadata),
    timelineRows,
    tokenEvents,
  });
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
    // Emitted unconditionally so a read-only session (null) heals a stale
    // cloud branch rather than preserving the omitted field (AC8).
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

/**
 * FEA-3671: SSOT predicate for "this session has a parsed transcript". The
 * parser writes the visible turn stream to `metadata.$.messages`, from which it
 * has ALREADY excluded synthetic `user`-role entries — `isMeta` slash-command
 * expansions (e.g. `/login`), compaction summaries, and non-human origins
 * (`isSyntheticUserEntry` in packages/lib/harness/claude/parse-claude.ts). So a
 * `role:"human"` message in `$.messages` is the authoritative human-turn signal.
 *
 * This mirrors, in intent, the human-turn rollup's own precedence (session-analytics-rollup.ts
 * `COALESCE(transcript_human_turns, ht.human_turns, 0)`): when a transcript
 * exists, `role:"human"` message rows are authoritative and the hook-captured
 * `event_type LIKE '%user%'|'%prompt%'` events are IGNORED for the human-turn
 * count; only a transcript-less (hook-only live) session falls back to those
 * events. The `json_type($.messages) = 'array'` test in that SQL is exactly
 * `Array.isArray(metadata?.messages)` here.
 *
 * The timeline prompt markers MUST honor the same precedence so they can't
 * disagree with humanTurns: a meta-only `/login` session parses to a transcript
 * with zero `role:"human"` messages (humanTurns=0) yet still carries
 * `UserPromptSubmit` hook events — those must NOT emit human `prompt` markers, or
 * the timeline contradicts the count (the bug Andrew reported).
 */
function sessionHasParsedTranscript(
  metadata: Record<string, unknown> | null
): boolean {
  return Array.isArray(metadata?.messages);
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
            // FEA-3419: 1h-correct fallback when the row carried the split.
            ...(tokenEvent.cache_write_1h_tokens == null
              ? {}
              : { cacheWrite1hTokens: tokenEvent.cache_write_1h_tokens }),
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
  return rows.flatMap((row, index): SessionMarker[] => {
    const kind = traceMarkerKind(row, hasTranscript);
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
  // entries). Hook `UserPromptSubmit` events (also `event_type` matching
  // user/prompt) are NOT human turns in that regime, so they must NOT emit a
  // prompt marker — otherwise a meta-only `/login` session shows prompt markers
  // while humanTurns=0. Only a transcript-less (hook-only live) session falls back
  // to the broad user/prompt event-name match, exactly as the human-turn rollup's
  // COALESCE(transcript_human_turns, ht.human_turns) fallback does.
  if (
    hasTranscript
      ? row.eventType === "UserMessage"
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

function formatTraceClockOffset(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// FEA-3586: the min/max parseable activity timestamp across the trace's timeline
// rows and token events. Used to tighten the bucket/marker window to the real
// activity span so a stale end anchor can't compress every bar into hour one.
function activityExtentMs(
  timelineRows: readonly TraceTimelineRow[],
  tokenEvents: SessionTraceSyncInput["tokenEvents"]
): { minMs: number; maxMs: number } {
  let minMs = Number.NaN;
  let maxMs = Number.NaN;
  const consider = (value: string) => {
    const ms = parseIsoMs(value);
    if (!Number.isFinite(ms)) {
      return;
    }
    // `!(a <= b)` / `!(a >= b)` so a NaN seed is always replaced by a real ms.
    if (!(minMs <= ms)) {
      minMs = ms;
    }
    if (!(maxMs >= ms)) {
      maxMs = ms;
    }
  };
  for (const row of timelineRows) {
    consider(row.createdAt);
  }
  for (const event of tokenEvents) {
    consider(event.created_at);
  }
  return { minMs, maxMs };
}

function clampToRange(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
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

function stringFromMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function numberFromMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// FEA-3267: an absent metadata LOC field stays absent; a present one is bounded
// to the cloud's int4 LOC range, yielding undefined (field omitted) when it is
// out of range.
function boundedLocFromMetadata(value: unknown): number | undefined {
  return value === undefined
    ? undefined
    : boundedNonNegativeInt(numberFromMetadata(value));
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
  buildDiffStats,
  buildSessionTraceSyncFields,
  buildTraceTimelineRows,
  resolveArtifactLinkBranch,
  resolveTraceEndMs,
};
