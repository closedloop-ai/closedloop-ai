import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
  SyncedAgentSessionTokenUsage,
} from "@repo/api/src/types/agent-session";
import {
  LOC_PER_DOLLAR_LABEL,
  locPerDollarFromLines,
  resolveLocPerDollar,
} from "@repo/api/src/utils/loc-per-dollar";
import {
  CostAvailability,
  deriveCostAvailability,
  formatCostLabel,
  getCostTooltip,
} from "@repo/app/agents/lib/cost-availability";
import { resolveSessionDetailDurationWindow } from "@repo/app/agents/lib/session-detail-duration-window";
import {
  resolveSessionDurationDetail,
  resolveSessionWallClockLabel,
  resolveSessionWallClockMs,
  type SessionDurationWindow,
} from "@repo/app/agents/lib/session-duration";
import { resolveSessionRepositoryLabel } from "@repo/app/agents/lib/session-repository-label";
import type {
  AgentStatus,
  EventFilterSelection,
  SessionEvent,
  SessionEventFacets,
  SessionEventGroup,
  SessionOverviewStats,
} from "@repo/app/agents/lib/session-types";
import {
  isSessionMainAgent,
  resolveSubagentCount,
} from "@repo/app/agents/lib/subagent-transcripts";
import {
  ensureDate,
  formatDate,
  formatDateTime,
} from "@repo/app/shared/lib/date-utils";
import {
  formatCost,
  formatLocPerDollar,
  formatNumber,
  formatTokenCount,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { asRecord } from "@repo/lib/harness/type-guards";
import { buildSessionAgents } from "./agent-tree-utils";

export type AgentSessionDetailContent = ReturnType<
  typeof buildSessionDetailContent
>;

/**
 * FEA-3630 / FEA-4250 / ISS-4667: per-session LOC/$ (cost-efficiency) — lines of
 * code delivered per dollar spent. Mirrors the org-level
 * `AgentSessionUsageSummary.mergedLocPerDollar` but for a single session:
 *
 *   locPerDollar = (linesAdded + linesRemoved) / estimatedCost
 *
 * ISS-4667: raw LINES per dollar — NO divide-by-1000 and never inverted. The
 * KLOC unit floored a real 4,004-line / $4,574.72 session to a misleading
 * `0.00`; in LOC/$ the same session reads `0.88`.
 *
 * FEA-4250 makes this a server-projected field (`session.locPerDollar`) so the
 * read contract carries it. When present it is authoritative — computed from the
 * same diff stats against the *reconciled* cost, so it can never disagree with
 * the served Cost — and is returned verbatim (a `null` is the server's honest
 * "unavailable", preserved, not recomputed). A producer that predates ISS-4667
 * omits it and sends the deprecated KLOC-unit `klocPerDollar` alias instead;
 * {@link resolveLocPerDollar} scales that into LOC/$ rather than rendering it a
 * thousand times too small. Only a producer sending NEITHER field falls back to
 * the local derivation below.
 *
 * Local fallback (FEA-4378 / ISS-4448): the numerator is
 * {@link sessionLocPerDollarNumeratorLines}, which resolves the same three real
 * signals the "Lines changed" row does (local working-tree diff, branch-level
 * diff, and the authored-PR roll-up, largest wins) — so the ratio's numerator
 * always reconciles with the "Lines changed" the same panel prints. The
 * session-level `linesAdded/linesRemoved` scalars are the LOCAL working-tree git
 * diff, which collapses to a tiny residual once a multi-PR session's branches
 * are merged/reset — so a 13-PR session can read `+136 -2` and drive the ratio
 * to ~0. When the authored-PR roll-up or the branch-level diff is larger it is
 * the real delivered code and wins. Returns `null` when the ratio is genuinely
 * undefined (no cost / no lines) so the UI renders the not-applicable
 * placeholder; every field is optional+nullable and coerces a missing value to
 * 0, never `NaN`. The lines/cost ratio + guards are the shared SSOT
 * {@link locPerDollarFromLines}.
 */
export function computeSessionLocPerDollar(
  session: Pick<
    AgentSessionDetail,
    | "linesAdded"
    | "linesRemoved"
    | "locPerDollar"
    | "klocPerDollar"
    | "authoredPrLinesChanged"
    | "branchDiffStats"
  > & {
    estimatedCost: number;
  }
): number | null {
  if (
    session.locPerDollar !== undefined ||
    session.klocPerDollar !== undefined
  ) {
    return resolveLocPerDollar(session.locPerDollar, session.klocPerDollar);
  }
  return locPerDollarFromLines(
    sessionLocPerDollarNumeratorLines(session),
    session.estimatedCost
  );
}

/**
 * ISS-4979 (#4291 review): the Duration MetricCard caption when the span is
 * absent, replacing the bounds caption {@link resolveSessionDurationDetail}
 * names on the two measurable branches.
 *
 * Same move the Events card beside it already makes with
 * {@link EVENT_RATE_UNAVAILABLE}: once the value slot can go empty, keeping the
 * measured-span caption underneath it still claims a measurement nothing made —
 * it names the two bounds the number was supposedly taken between, for a number
 * that does not exist. The caption states the absence instead.
 */
export const DURATION_UNRECORDED_DETAIL = "Length not recorded";

/**
 * ISS-4675: the Events MetricCard caption when the rate has no measurable
 * denominator — an unresolvable duration, or a measured zero-length span.
 *
 * It is a SENTENCE, not an omission. The Duration card sitting beside the Events
 * card is driven by the same span, so it drops to its no-data slot on exactly
 * the same input; dropping this caption too left two cards quiet at once with
 * nothing on screen saying why either went quiet.
 */
export const EVENT_RATE_UNAVAILABLE = "Rate unavailable";

/**
 * ISS-4667: display string for the per-session LOC/$ efficiency metric via the
 * shared {@link formatLocPerDollar} — adaptive precision (a genuinely small but
 * non-zero ratio never floors to `0.00`) and the distinct not-applicable
 * placeholder when the ratio is undefined ($0 cost / no lines).
 */
export function formatSessionLocPerDollar(
  session: Pick<
    AgentSessionDetail,
    "linesAdded" | "linesRemoved" | "locPerDollar" | "klocPerDollar"
  > & {
    estimatedCost: number;
  }
): string {
  return formatLocPerDollar(computeSessionLocPerDollar(session));
}

/**
 * The view-model for the session-detail PANELS — the event timeline groups and
 * facets, the Overview stats, the tool-invocation rows, the per-event
 * pretty-printed JSON, and the rendered metadata/attribution blobs.
 *
 * ISS-5072: CALL THIS ONLY WHERE THOSE PANELS ARE ACTUALLY MOUNTED. It is an
 * O(events · log events) build plus a full `JSON.stringify` pass over the
 * unbounded `session.events` corpus, and today its renderers
 * (`SessionTimelineSection`, `SessionOverviewSection`, `SessionErrorDetailsPanel`,
 * `SessionAgentsSection`, `SessionSummaryMetrics`) are mounted only in Storybook.
 * `AgentSessionDetailView` used to build the whole thing in a `useMemo` keyed on
 * the detail record — so every refetch that returned a new object rebuilt it —
 * and then read a single field out of it, the Cost metric. That one value is
 * `formatCostLabel(deriveCostAvailability(session), session.estimatedCost)`,
 * which the shipped view now takes directly from the shared
 * `deriveSessionCostLabel`. Reach for a narrow derivation like that before
 * building this whole bag to read one entry out of it.
 */
export function buildSessionDetailContent(
  session: AgentSessionDetail,
  options: SessionDetailContentOptions = {}
) {
  const toolInvocations = buildToolInvocations(session.events);
  const errorEvents = session.events.filter((event) =>
    event.eventType.toLowerCase().includes("error")
  );
  const agentNames = new Map(
    session.agents.map((agent) => [agent.externalAgentId, agent.name])
  );

  // ISS-5131 (#4409 review): ONE clock read for the whole build, so the Duration
  // MetricCard, the Overview card, the event-rate denominator and the "Ended"
  // metadata below are all the same measurement rather than four reads of a
  // clock that moved between them.
  const nowMs = options.nowMs ?? Date.now();
  const overview = buildOverviewStats(session, toolInvocations, nowMs);
  const sessionAgents = buildSessionAgents(session.agents, session.events);
  const eventData = buildEventData(session, agentNames);

  const costAvailability = deriveCostAvailability(session);
  const costTooltip = getCostTooltip(costAvailability);
  const locPerDollarAvailable =
    costAvailability === CostAvailability.Available ||
    costAvailability === CostAvailability.Subscription;

  // ISS-5131: the ONE Duration rule — `now - start` while running, `end - start`
  // once terminal. The Sessions list cell, the Overview card below, and the
  // Properties row all resolve the identical window, so the four Durations on
  // and around this screen cannot disagree. The caption is derived from that
  // same window rather than fixed, so it names the bounds the number was
  // actually taken between.
  //
  // ISS-5575: "identical" now includes the INPUT. This read the raw stored
  // status while the list mapper read the DISPLAYED one, so a silent `active`
  // run showed "—" in the list and a climbing number here.
  const durationWindow = resolveSessionDetailDurationWindow({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    now: new Date(nowMs),
    startedAt: session.startedAt,
    status: session.status,
  });
  const durationValue = resolveSessionWallClockLabel(
    session.startedAt,
    durationWindow,
    nowMs
  );

  return {
    metrics: [
      {
        label: "Duration",
        // ISS-4979 (#4291 review): `null` is passed STRAIGHT THROUGH to the card
        // rather than coerced to an em-dash string. `MetricCard` already owns
        // this case — a nullish `value` renders its muted "No data" glyph — and
        // handing it the literal "—" defeated that path, printing the rule
        // character in the bold 2xl value slot, which is exactly the FEA-4236
        // rule that an absent metric must not read as a struck value. The
        // Overview Duration card below already passes `null`, so the coercion
        // also made ONE absent fact render two different ways on one page.
        value: durationValue,
        // ISS-4979 (#4291 review): the caption follows the value. A bounds
        // caption under an empty slot still names the two bounds a nonexistent
        // number was supposedly measured between — the same reason the Events
        // card beside it swaps to "Rate unavailable".
        detail: resolveDurationCaption(durationWindow, durationValue),
      },
      {
        label: "Tokens",
        value: formatTokenCount(
          session.inputTokens +
            session.outputTokens +
            session.cacheReadTokens +
            session.cacheWriteTokens
        ),
        detail: "Input + output + cache",
      },
      {
        label: "Cost",
        value: formatCostLabel(costAvailability, session.estimatedCost),
        detail: `${formatNumber(session.toolUseCount)} tool uses`,
        info: costTooltip ? { what: costTooltip } : undefined,
      },
      {
        label: "Errors",
        value: formatNumber(session.errorCount),
        detail: `${formatNumber(session.agentCount)} agents`,
      },
      {
        label: LOC_PER_DOLLAR_LABEL,
        value: locPerDollarAvailable
          ? formatSessionLocPerDollar(session)
          : KPI_NO_VALUE,
        detail: "Lines changed per dollar",
      },
    ],
    metadata: [
      { label: "Session ID", value: session.externalSessionId },
      { label: "Repository", value: resolveSessionRepositoryLabel(session) },
      {
        label: "Compute Target",
        value: session.computeTarget.machineName,
      },
      { label: "Started", value: safeFormatDateTime(session.startedAt) },
      // ISS-5131 (wongk, #4409): derived from the SAME window the Duration cards
      // above resolved, not from `endedAt` alone. The window supports two shapes
      // this row used to get wrong, both of them a straight contradiction with
      // the Duration beside it: a TERMINAL session with no end instant printed
      // the end timestamp's absence as "Still running" next to a Duration reading
      // "Length not recorded", and a RUNNING session carrying a leftover
      // `endedAt` (ISS-5182 clears it on resume; until then it lingers) printed
      // that stale timestamp next to a Duration captioned "Start to now".
      {
        label: "Ended",
        value: resolveEndedMetadataValue(session, durationWindow),
      },
      {
        label: "User",
        value: session.user ? getUserDisplayName(session.user) : "Unattributed",
      },
    ],
    details: [
      { label: "Worktree", value: session.worktreePath ?? "Unknown" },
      { label: "CWD", value: session.cwd ?? "Unknown" },
      { label: "Base branch", value: session.baseBranch ?? "Unknown" },
      {
        label: "Source artifact",
        value: session.sourceArtifactId ?? "None",
      },
      { label: "Source loop", value: session.sourceLoopId ?? "None" },
    ],
    attribution: session.attribution ? renderJson(session.attribution) : null,
    overview,
    modelUsage: session.tokenUsageByModel.map((usage) => ({
      model: usage.model,
      inputTokens: formatTokenCount(usage.inputTokens),
      outputTokens: formatTokenCount(usage.outputTokens),
      cacheReadTokens: formatTokenCount(usage.cacheReadTokens),
      cacheWriteTokens: formatTokenCount(usage.cacheWriteTokens),
      estimatedCost: formatCost(usage.estimatedCostUsd ?? 0),
    })),
    toolInvocations: toolInvocations.map((tool) => ({
      toolName: tool.toolName,
      count: formatNumber(tool.count),
      firstSeenAt: safeFormatDateTime(tool.firstSeenAt),
      lastSeenAt: safeFormatDateTime(tool.lastSeenAt),
    })),
    errors: errorEvents.map((event) => ({
      id: event.externalEventId,
      eventType: event.eventType,
      createdAt: safeFormatDateTime(event.createdAt),
      summary: event.summary ?? "No error summary provided.",
      rawData:
        event.data === undefined ? null : JSON.stringify(event.data, null, 2),
    })),
    sessionAgents,
    eventData,
    rawMetadata: session.metadata ? renderJson(session.metadata) : null,
  };
}

function renderJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/**
 * FEA-3419: the ephemeral cache-write TTL split (5-minute vs 1-hour cache-
 * creation tokens) for a session, derived from the typed per-model token
 * usage. A subdivision of the canonical cache-write total — never additive.
 */
export type CacheWriteTtlBreakdown = {
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
};

/** Coerce an untrusted wire value to a safe non-negative integer. */
function nonNegativeTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

/**
 * FEA-3419: derive the session-wide cache-write TTL split (5-minute vs 1-hour
 * ephemeral cache-write tokens) from the TYPED per-model token usage — the
 * single source of truth on both surfaces (web reads the cloud
 * `agent_session_token_usage` columns; desktop reads its local `token_usage`
 * columns through the same `SyncedAgentSessionTokenUsage` shape). Replaces the
 * FEA-3528 metadata-blob spelunking: the `usageExtras.cache_creation` blob no
 * longer exists.
 *
 * Returns `null` when NO model reported a breakdown (absent provenance —
 * legacy sessions, non-Claude harnesses, pre-TTL desktop builds) or when the
 * reported split is entirely zero — so callers omit the row rather than render
 * a `0|0` line.
 */
export function deriveCacheWriteTtlBreakdown(
  tokenUsageByModel: readonly SyncedAgentSessionTokenUsage[] | undefined
): CacheWriteTtlBreakdown | null {
  if (!tokenUsageByModel) {
    return null;
  }
  let ephemeral5mInputTokens = 0;
  let ephemeral1hInputTokens = 0;
  let reported = false;
  for (const usage of tokenUsageByModel) {
    if (usage.cacheWrite1hTokens == null && usage.cacheWrite5mTokens == null) {
      continue;
    }
    reported = true;
    ephemeral5mInputTokens += nonNegativeTokenCount(usage.cacheWrite5mTokens);
    ephemeral1hInputTokens += nonNegativeTokenCount(usage.cacheWrite1hTokens);
  }
  if (
    !reported ||
    (ephemeral5mInputTokens === 0 && ephemeral1hInputTokens === 0)
  ) {
    return null;
  }
  return { ephemeral5mInputTokens, ephemeral1hInputTokens };
}

/**
 * FEA-3703: aggregate per-turn Codex token COUNTS captured from a
 * `token_count.last_token_usage` snapshot. COUNTS ONLY — never any raw reasoning
 * content (Codex `reasoning_output_tokens` is folded into `output` upstream and
 * is a bare integer here). `total` is the derived grand-total prompt+output size
 * (`input + output + cacheRead + cacheWrite`).
 */
export type CodexTokenUsageCounts = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

/**
 * FEA-3703: a single Codex rate-limit window (primary = shortest, secondary =
 * longer) surfaced for display. `usedPercent` is clamped to [0, 100];
 * `windowMinutes` and `resetsAtEpochSeconds` are passed through when well-formed,
 * else null — so an absent field renders an em-dash rather than a lie.
 * `resetsAtEpochSeconds` is the Codex `resets_at` value, an ABSOLUTE Unix
 * epoch-seconds timestamp (FEA-3524) — the same shape the desktop session-limits
 * mappers treat as epoch — NOT a relative seconds-from-now delta. The remaining
 * time is computed against the current clock at render (see
 * `formatCodexRateLimitWindow`).
 */
export type CodexRateLimitWindowView = {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAtEpochSeconds: number | null;
};

/**
 * FEA-3703: the read-time view model for the persisted Codex runtime metadata
 * (FEA-3524 rate limits, FEA-3525 context window, FEA-3526 last-token-usage
 * snapshots). Assembled from the session `metadata` blob, which both the cloud
 * sync and the desktop local read carry through unchanged — so a single selector
 * serves web AND desktop. Every field is independently nullable to preserve the
 * absent / unsupported / malformed distinctions: a Codex session that reported
 * only a context window yields `{ modelContextWindow, latestTokenUsage: null,
 * rateLimits: null }` rather than an all-or-nothing tile.
 */
export type CodexRuntimeMetadata = {
  /** Codex `token_count.info.model_context_window` (tokens), or null. */
  modelContextWindow: number | null;
  /**
   * Aggregate COUNTS from the freshest well-formed `last_token_usage` snapshot
   * (the "last good" sample), or null when none is well-formed.
   */
  latestTokenUsage: CodexTokenUsageCounts | null;
  /**
   * Context-window utilization for the latest snapshot: `latest.total /
   * modelContextWindow`, clamped to [0, 100]. Null unless BOTH a context window
   * and a latest snapshot are present (utilization is undefined otherwise).
   */
  contextWindowUtilizationPercent: number | null;
  /** Latest well-formed rate-limit windows, or null when none was captured. */
  rateLimits: {
    primary: CodexRateLimitWindowView | null;
    secondary: CodexRateLimitWindowView | null;
  } | null;
};

/** Coerce an untrusted value to a finite non-negative integer, else null. */
function optionalTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

/** Coerce an untrusted percent to a finite value clamped to [0, 100], else null. */
function optionalPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return clampPercentValue(value);
}

function clampPercentValue(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

/** Coerce an untrusted value to a finite non-negative epoch/number, else null. */
function optionalFiniteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * Read the aggregate token COUNTS from one persisted Codex snapshot
 * (`metadata.codexLastTokenUsage[i].lastTokenUsage`). Returns null when the
 * snapshot is malformed or reports no tokens at all (so a zero-only sample never
 * masquerades as a real "last good" reading). COUNTS ONLY — the caller never
 * reads message/reasoning text out of this blob.
 */
function readCodexTokenCounts(entry: unknown): CodexTokenUsageCounts | null {
  const usage = asRecord(asRecord(entry)?.lastTokenUsage);
  if (!usage) {
    return null;
  }
  const input = optionalTokenCount(usage.input) ?? 0;
  const output = optionalTokenCount(usage.output) ?? 0;
  const cacheRead = optionalTokenCount(usage.cacheRead) ?? 0;
  const cacheWrite = optionalTokenCount(usage.cacheWrite) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, total };
}

/**
 * Pick the freshest well-formed snapshot's counts — the "last good" reading —
 * scanning from the end of the array (parsers append in event order) so a
 * trailing malformed/zero entry falls back to the last real one rather than
 * blanking the tile.
 */
function latestCodexTokenCounts(value: unknown): CodexTokenUsageCounts | null {
  if (!Array.isArray(value)) {
    return null;
  }
  for (let index = value.length - 1; index >= 0; index--) {
    const counts = readCodexTokenCounts(value[index]);
    if (counts) {
      return counts;
    }
  }
  return null;
}

/** Map one persisted rate-limit window; null when the block is malformed/absent. */
function readCodexRateLimitWindow(
  value: unknown
): CodexRateLimitWindowView | null {
  const window = asRecord(value);
  if (!window) {
    return null;
  }
  const usedPercent = optionalPercent(window.used_percent);
  const windowMinutes = optionalFiniteNonNegative(window.window_minutes);
  const resetsAtEpochSeconds = optionalFiniteNonNegative(window.resets_at);
  if (
    usedPercent === null &&
    windowMinutes === null &&
    resetsAtEpochSeconds === null
  ) {
    return null;
  }
  return { usedPercent, windowMinutes, resetsAtEpochSeconds };
}

/**
 * FEA-3703: assemble the {@link CodexRuntimeMetadata} view model from the
 * untyped, possibly cloud-synced session metadata blob. Reads defensively — a
 * missing, wrong-typed, or malformed value coerces to null per-field rather than
 * throwing or leaking a bad value. Returns null only when NONE of the three
 * signals is present, so callers omit the tile entirely for non-Codex sessions
 * (and every pre-FEA-3524/3525/3526 payload) rather than rendering an empty box.
 */
export function extractCodexRuntimeMetadata(
  metadata: AgentSessionDetail["metadata"]
): CodexRuntimeMetadata | null {
  const blob = asRecord(metadata);
  if (!blob) {
    return null;
  }
  const modelContextWindow = optionalTokenCount(blob.modelContextWindow);
  const latestTokenUsage = latestCodexTokenCounts(blob.codexLastTokenUsage);
  const rateLimitsBlob = asRecord(blob.codexRateLimits);
  const primary = rateLimitsBlob
    ? readCodexRateLimitWindow(rateLimitsBlob.primary)
    : null;
  const secondary = rateLimitsBlob
    ? readCodexRateLimitWindow(rateLimitsBlob.secondary)
    : null;
  const rateLimits = primary || secondary ? { primary, secondary } : null;

  if (modelContextWindow === null && !latestTokenUsage && !rateLimits) {
    return null;
  }

  const contextWindowUtilizationPercent =
    modelContextWindow && modelContextWindow > 0 && latestTokenUsage
      ? clampPercentValue((latestTokenUsage.total / modelContextWindow) * 100)
      : null;

  return {
    modelContextWindow,
    latestTokenUsage,
    contextWindowUtilizationPercent,
    rateLimits,
  };
}

function normalizeEventStatus(event: SyncedAgentSessionEvent): AgentStatus {
  const eventType = event.eventType.toLowerCase();
  if (eventType.includes("error") || eventType.includes("fail")) {
    return "error";
  }
  if (
    eventType.includes("complete") ||
    eventType.includes("success") ||
    eventType.includes("finish")
  ) {
    return "completed";
  }
  if (eventType.includes("wait") || eventType.includes("queued")) {
    return "waiting";
  }
  return "working";
}

function buildEventData(
  session: AgentSessionDetail,
  agentNames: Map<string, string>
): {
  facets: SessionEventFacets;
  groups: SessionEventGroup[];
  activeFilters: EventFilterSelection;
} {
  // ISS-5073: parse each `createdAt` EXACTLY ONCE. The previous shape ran
  // `ensureDate` → `parseDateLocal` → date-fns `parseISO` on BOTH operands of
  // every sort comparison, then twice more in the mapping and grouping passes —
  // roughly 2·N·log₂N parses for an N-event session where N suffices.
  // Decorate-sort-undecorate: parse once per event, derive the normalized
  // timestamp, sort key, and group key from that single Date, sort on the
  // precomputed number, then unwrap.
  const decorated = session.events
    .map((event) => decorateSessionEvent(event, session.id, agentNames))
    .sort((left, right) => right.sortKey - left.sortKey);

  // ISS-5073 (#4366 review): the group LABEL is formatted once per GROUP — G
  // times, not N. `formatLocalCalendarGroupTitle` runs date-fns `format`, which
  // is meaningfully heavier than the `parseISO` this refactor removed, so
  // deriving it per entry would trade an O(G) cost for an O(N) one and spend
  // more than the parse saving on a single-day session with thousands of
  // events. Formatting it when the bucket is CREATED still reads the very same
  // `Date` that produced that entry's `groupKey`, so the key and the label can
  // never describe different days.
  const events: SessionEvent[] = [];
  const grouped = new Map<string, SessionEventGroup>();
  for (const entry of decorated) {
    events.push(entry.event);
    const bucket = grouped.get(entry.groupKey);
    if (bucket) {
      bucket.events.push(entry.event);
    } else {
      grouped.set(entry.groupKey, {
        id: entry.groupKey,
        title: formatLocalCalendarGroupTitle(entry.createdAtDate),
        events: [entry.event],
      });
    }
  }

  const groups = [...grouped.values()];

  return {
    facets: {
      statuses: [...new Set(events.map((event) => event.status))],
      eventTypes: [...new Set(events.map((event) => event.eventType))],
      toolNames: [
        ...new Set(
          events.map((event) => event.toolName).filter(Boolean) as string[]
        ),
      ],
      agents: [...agentNames.entries()].map(([id, label]) => ({ id, label })),
    },
    groups,
    activeFilters: {
      query: "",
      statuses: [],
      eventTypes: [],
      toolNames: [],
      agents: [],
    },
  };
}

function buildOverviewStats(
  session: AgentSessionDetail,
  toolInvocations: Array<{ toolName: string; count: number }>,
  nowMs: number
): SessionOverviewStats {
  // ISS-4675 / ISS-5131: the event RATE divides by the SAME span the Duration on
  // this screen shows, resolved from the SAME window, so "N events / min" is a
  // number the reader can recompute from the two values in front of them.
  // ISS-5575: that promise only holds while both read the DISPLAYED status.
  const durationWindow = resolveSessionDetailDurationWindow({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    now: new Date(nowMs),
    startedAt: session.startedAt,
    status: session.status,
  });
  const totalDurationMs = resolveSessionWallClockMs(
    session.startedAt,
    durationWindow,
    nowMs
  );
  // FRACTIONAL minutes, with no 1-minute floor. The floor was tolerable while
  // the denominator was the calendar span, and it became materially reachable
  // once the denominator became `wallClock`: the collector emits `wallClock` for
  // every session where `endMs >= startMs`
  // (`apps/desktop/src/main/database/session-trace-duration.ts`), so short-burst
  // and degenerate windows really do arrive as "12s" and "0s". Flooring made
  // 60 events over a DISPLAYED 30s report "60 events / min" when the number the
  // reader can compute from the two values on screen is 120 — the exact
  // reconciliation failure ISS-4675 is fixing, reintroduced in the denominator.
  //
  // A NON-POSITIVE or UNRESOLVABLE span yields no rate at all rather than a
  // fabricated one: dividing by a measured `0s` is not a large rate, it is an
  // undefined one, and flooring `null` to 1 rendered the entire event count as
  // the rate — "203 events / min" over a span nothing measured.
  const totalMinutes =
    totalDurationMs === null || totalDurationMs <= 0
      ? null
      : totalDurationMs / 60_000;
  const eventMix = new Map<string, number>();
  const { rankedSubagentTypes, compactions } = buildSubagentTypeTally(
    session.agents
  );
  // ISS-5366: resolved ONCE. The Subagents metric and `subagentTypesAvailable`
  // are two renderings of this one answer, and computing it twice is what let
  // them contradict each other on screen. `null` is "not known", never zero.
  const subagentCount = resolveSubagentCount(session);
  for (const event of session.events) {
    eventMix.set(event.eventType, (eventMix.get(event.eventType) ?? 0) + 1);
  }

  const activeAgent = session.agents.find((agent) =>
    ["working", "active", "running"].some((token) =>
      agent.status.toLowerCase().includes(token)
    )
  );
  // ISS-5131: the same window the Duration MetricCard, the Properties row, and
  // the Sessions list resolve.
  // ISS-4675: an unresolvable span stays `null` so the MetricCard renders its own
  // no-data slot; a hand-passed em-dash STRING renders as a bold 2xl value that
  // is still captioned with two bounds, which reads as a measurement rather than
  // as an absence.
  const overviewDurationLabel = resolveSessionWallClockLabel(
    session.startedAt,
    durationWindow,
    nowMs
  );

  return {
    totalEvents: session.events.length,
    toolCalls: session.toolUseCount,
    // SSOT with the transcript switcher's reconciliation (ISS-4677): one
    // derivation of "how many subagents did this session run", so the Subagents
    // MetricCard and the switcher's "N of M" can never drift apart.
    //
    // ISS-5366: the null now SURVIVES to the surface. It used to be coerced
    // here with `?? 0` on the stated ground that "a MetricCard has no null
    // rendering" — which stopped being true when `MetricCard` learned to derive
    // its no-data slot from a nullish `value` (FEA-4236). The coercion had
    // become a lie the panel then contradicted three cards later: both
    // producers set `agentCount = agents.length`
    // (`apps/api/app/agent-sessions/service/upsert-session-slice.ts` and
    // `apps/desktop/src/main/session/shared-agent-sessions-api.ts`), so a
    // session whose agent rows have not arrived has `agents.length === 0`,
    // `resolveSubagentCount` returns null, and `subagentTypesAvailable` below
    // goes false — leaving one panel rendering a confident "Subagents 0" beside
    // "Subagent types aren't available for this session." Two claims about one
    // unknown, and the number is the one a reader believes.
    subagents: subagentCount,
    compactions,
    errors: session.errorCount,
    durationLabel: overviewDurationLabel,
    // ISS-4979 (#4291 review): the caption follows the value here too, so the
    // Overview Duration card and the Duration MetricCard state an absent span
    // the SAME way. See `DURATION_UNRECORDED_DETAIL`.
    durationDetail: resolveDurationCaption(
      durationWindow,
      overviewDurationLabel
    ),
    // ISS-4675: SAY the rate is unavailable rather than dropping the caption.
    // The Duration card beside it goes quiet on exactly the same input, so
    // silently removing this line left two cards blank at once with nothing
    // explaining either.
    eventRateHint:
      totalMinutes === null
        ? EVENT_RATE_UNAVAILABLE
        : `${formatNumber(
            Math.round(session.events.length / totalMinutes)
          )} events / min`,
    topTools: toolInvocations.slice(0, 6),
    // ISS-4677: busiest first with a stable tie-break, capped like `topTools`,
    // instead of dumping every entry in Map insertion order.
    subagentTypes: rankedSubagentTypes.slice(0, MAX_SUBAGENT_TYPE_ENTRIES),
    // ISS-4677: how many distinct TYPES the cap dropped, and how many SUBAGENTS
    // sit inside them. Both are needed: the visible chip counts sum to less than
    // the Subagents metric rendered directly above, and only the agent count
    // closes that gap — a count of types never reaches it. The surface states
    // the remainder in both units rather than silently truncating. Both keys
    // stay optional+additive on the wire type, because a producer that predates
    // ISS-4677 still omits them and the surface reads that absence as "nothing
    // hidden".
    subagentTypesOmitted: Math.max(
      rankedSubagentTypes.length - MAX_SUBAGENT_TYPE_ENTRIES,
      0
    ),
    subagentTypesOmittedAgentCount: rankedSubagentTypes
      .slice(MAX_SUBAGENT_TYPE_ENTRIES)
      .reduce((total, entry) => total + entry.count, 0),
    // ISS-4677: an empty `subagentTypes` means "no subagents" ONLY when the
    // agent rows actually arrived. `resolveSubagentCount` returns null for the
    // loading/unavailable shape (`agentCount < 1`), and zero agent rows on a
    // session that reports agents is the same gap.
    //
    // ISS-5366: reads the SAME `subagentCount` the metric above renders rather
    // than re-calling the resolver, so the two fields cannot answer the same
    // question differently — that divergence is the whole defect.
    subagentTypesAvailable: session.agents.length > 0 && subagentCount !== null,
    tokens: {
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
    },
    eventMix: [...eventMix.entries()].map(([eventType, count]) => ({
      eventType,
      count,
    })),
    activeAgent: activeAgent
      ? {
          name: activeAgent.name,
          currentTool: activeAgent.currentTool,
          task: activeAgent.task,
        }
      : null,
  };
}

function buildToolInvocations(events: SyncedAgentSessionEvent[]) {
  const grouped = new Map<
    string,
    {
      toolName: string;
      count: number;
      firstSeenAt: string;
      lastSeenAt: string;
    }
  >();
  for (const event of events) {
    const toolName = event.toolName?.trim();
    if (!toolName) {
      continue;
    }
    const createdAt = normalizeDateTimeString(event.createdAt);
    const existing = grouped.get(toolName);
    if (!existing) {
      grouped.set(toolName, {
        toolName,
        count: 1,
        firstSeenAt: createdAt,
        lastSeenAt: createdAt,
      });
      continue;
    }
    existing.count += 1;
    if (createdAt < existing.firstSeenAt) {
      existing.firstSeenAt = createdAt;
    }
    if (createdAt > existing.lastSeenAt) {
      existing.lastSeenAt = createdAt;
    }
  }
  return [...grouped.values()].sort((left, right) => right.count - left.count);
}

function normalizeDateTimeString(
  date: Date | string | null | undefined
): string {
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "Unknown";
  }
  return parsed.toISOString();
}

/** Formats nullable or invalid session timestamps into a user-safe label. */
export function safeFormatDateTime(
  date: Date | string | null | undefined
): string {
  if (!date) {
    return "Unknown";
  }
  const parsed = ensureDate(date);
  if (!(parsed && Number.isFinite(parsed.getTime()))) {
    return "Unknown";
  }
  return formatDateTime(parsed);
}

function getLocalCalendarDateKey(date: Date | null) {
  if (!date) {
    return "unknown";
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalCalendarGroupTitle(date: Date | null) {
  if (!date) {
    return "Unknown";
  }
  return formatDate(date);
}

/**
 * FEA-4378 / ISS-4448: the LOC/$ numerator line count. Derived from the SAME
 * resolution as the "Lines changed" row ({@link sessionOutputDiffDisplay}) — the
 * authored-PR roll-up, the branch-level diff, or the local working-tree diff,
 * whichever is the largest real signal — so the LOC/$ ratio and the displayed
 * "Lines changed" figure can never disagree about how much code the session
 * delivered. Previously this only weighed `max(localDiff, authoredPrLoc)` and
 * ignored `branchDiffStats`, so a merged 88-PR session could show "4,004 lines
 * changed" while the ratio was computed from the 56-line working-tree residual.
 * Every input is optional+nullable and coerces to 0.
 */
export function sessionLocPerDollarNumeratorLines(
  session: Pick<
    AgentSessionDetail,
    "linesAdded" | "linesRemoved" | "authoredPrLinesChanged" | "branchDiffStats"
  >
): number {
  const display = sessionOutputDiffDisplay(session);
  if (display.kind === "authored-pr") {
    return display.linesChanged;
  }
  return display.linesAdded + display.linesRemoved;
}

/**
 * FEA-4378 / ISS-4448: the "Lines changed" figure in the session-detail
 * Properties panel, resolved so it can never understate the session's shipped
 * diff nor be misread as the PRs' code when it is really the local working-tree
 * residual. Honest precedence over the best available real signal (highest
 * changed-total wins; ties keep the more authoritative source):
 *   - `authored-pr`: the summed lines *changed* across the session's AUTHORED PRs
 *     (`authoredPrLinesChanged`) — the real delivered code. The most authoritative
 *     roll-up; used when it is the largest signal (the multi-PR-merged case).
 *   - `branch-diff`: the session's branch-level `+added / -removed` diff
 *     (`branchDiffStats`, FEA-4250). ISS-4448: a session with 88 merged PRs but no
 *     authored-PR LOC (the PR-detail path is unreachable → `authoredPrLinesChanged`
 *     is 0) still carries a real branch diff (e.g. 3315/689); without this rung the
 *     row fell back to the tiny working-tree residual (+51 -5) and understated the
 *     shipped diff by two orders of magnitude. Used when the branch diff is
 *     materially larger than both the authored-PR roll-up and the local residual.
 *   - `working-tree`: the session's OWN `+added / -removed` diff
 *     (`linesAdded`/`linesRemoved`). Used when no larger authored-PR or branch
 *     signal is available (single-PR/live sessions, or version-skewed producers
 *     that omit the richer fields).
 *
 * What that third rung measures has moved twice, and the discriminant name is now
 * historical rather than descriptive. FEA-3922/FEA-3923 made these scalars always
 * TRANSCRIPT-derived, never git (`resolveLocSourcePatch` in
 * apps/api/app/agent-sessions/service/persist-session-children.ts nulls
 * `loc_source` for exactly that reason), so it stopped being a working-tree diff
 * then. ISS-5402 then folded a delegated sub-agent's authored lines into it, so on
 * a delegating session it counts the whole session's authored churn — parent plus
 * every folded sub-agent — and can be an order of magnitude above the shipped
 * diff (golden f7441d99: 345 -> 5313).
 *
 * That is intended, and the precedence is deliberately left alone: this rung has
 * always been "what this session itself did", the other two are "what shipped",
 * and the largest-wins rule exists so the row can never UNDERSTATE. What it must
 * not do is misdescribe the scope it picked, so each shape renders its own
 * qualifier ("in session" / "branch total" / "in PRs") — see
 * {@link SessionOutputDiff}. A delegating session now legitimately resolves to
 * the session rung with a large number; it is labeled as the session's own work,
 * not as the PRs' delivered code.
 */
export function sessionOutputDiffDisplay(
  session: Pick<
    AgentSessionDetail,
    "linesAdded" | "linesRemoved" | "authoredPrLinesChanged" | "branchDiffStats"
  >
):
  | { kind: "authored-pr"; linesChanged: number }
  | { kind: "branch-diff"; linesAdded: number; linesRemoved: number }
  | { kind: "working-tree"; linesAdded: number; linesRemoved: number } {
  const localDiff = (session.linesAdded ?? 0) + (session.linesRemoved ?? 0);
  const authoredPrLoc = session.authoredPrLinesChanged ?? 0;
  const branch = session.branchDiffStats ?? null;
  const branchAdded = branch?.linesAdded ?? 0;
  const branchRemoved = branch?.linesRemoved ?? 0;
  const branchDiff = branchAdded + branchRemoved;
  // Authored-PR is the most authoritative signal: it wins on a tie with either
  // other source (it never understates delivered code the way a post-merge
  // working-tree residual does).
  if (authoredPrLoc >= branchDiff && authoredPrLoc > localDiff) {
    return { kind: "authored-pr", linesChanged: authoredPrLoc };
  }
  // ISS-4448: prefer the branch-level diff when it is the larger real signal,
  // rather than collapsing to the tiny working-tree residual left after merge.
  if (branchDiff > localDiff && branchDiff > authoredPrLoc) {
    return {
      kind: "branch-diff",
      linesAdded: branchAdded,
      linesRemoved: branchRemoved,
    };
  }
  return {
    kind: "working-tree",
    linesAdded: session.linesAdded ?? 0,
    linesRemoved: session.linesRemoved ?? 0,
  };
}

/**
 * ISS-4677: cap on the Overview "Subagent types" tally, mirroring the
 * `topTools.slice(0, 6)` treatment — a busiest-first shortlist, not an
 * unbounded dump of every distinct type in Map insertion order.
 */
const MAX_SUBAGENT_TYPE_ENTRIES = 8;

/**
 * Build-time options for {@link buildSessionDetailContent}. ISS-5366 removed the
 * `subagentDisclosureEnabled` switch when the ISS-4677 disclosure graduated to
 * always-on, so only the ISS-5131 measurement instant remains.
 */
export type SessionDetailContentOptions = {
  /**
   * ISS-5131 (#4409 review): the instant a RUNNING session's Duration — and the
   * event-rate denominator derived from it — is measured to. Absent reads the
   * real clock ONCE per build, which is right for the Storybook and test callers
   * that mount this builder today (`AgentSessionDetailView` stopped calling it in
   * ISS-5072). A future PRODUCTION mount must pass a ticking value: this builder
   * runs inside a `useMemo`, so an ambient clock read would freeze a running
   * Duration and its rate at the last input change while captioning it
   * "Start to now".
   */
  nowMs?: number;
};

/**
 * The Overview "Subagent types" tally, plus the compaction count that shares its
 * scan of the agent rows.
 *
 * ISS-4677: the session's OWN main agent is not a subagent type. The
 * desktop writer inserts a root row (`type='main'`, `subagent_type=NULL`,
 * `parent_agent_id=NULL`), and tallying it under a "main" label made this list
 * disagree with the `subagents` metric beside it — a session with zero subagents
 * rendered "Subagent types (1)". The exclusion matches that root row EXACTLY
 * (all three fields), not the looser "has no parent" test, and it is the SAME
 * predicate `resolveSubagentCount` subtracts with, so the metric and these chips
 * partition the rows identically — including when the root row is missing and
 * there is nothing to subtract. An unparented row is labelled by its own `type`
 * rather than being filed under "main". Compactions still scan EVERY row, so the
 * tally is gated, not the loop.
 *
 * ISS-4779 (flag OFF): reproduces the prior tally verbatim — main included under
 * a "main" label, no exclusion, Map insertion order.
 */
function buildSubagentTypeTally(agents: AgentSessionDetail["agents"]): {
  rankedSubagentTypes: Array<{
    label: string;
    count: number;
    isCompaction: boolean;
  }>;
  compactions: number;
} {
  const subagentTypes = new Map<string, number>();
  let compactions = 0;
  for (const agent of agents) {
    const label = agent.subagentType ?? agent.type;
    if (!isSessionMainAgent(agent)) {
      subagentTypes.set(label, (subagentTypes.get(label) ?? 0) + 1);
    }
    if (
      label.toLowerCase().includes("compact") ||
      agent.name.toLowerCase().includes("compact")
    ) {
      compactions += 1;
    }
  }
  const entries = [...subagentTypes.entries()].map(([label, count]) => ({
    label,
    count,
    isCompaction: label.toLowerCase().includes("compact"),
  }));
  return {
    rankedSubagentTypes: entries.sort((left, right) =>
      right.count === left.count
        ? left.label.localeCompare(right.label)
        : right.count - left.count
    ),
    compactions,
  };
}

/**
 * ISS-4769: what the session-detail "Pull requests" row says when it has no PR
 * to show. The canonical string — the row imports it rather than re-declaring
 * the copy at the call site.
 *
 * The Properties-panel facts are assembled by INDEPENDENT lanes with mismatched
 * predicates: the PR lane counts only the PRs a session AUTHORED
 * (`resolveAuthoredPrLinkIdentity` — referenced/reviewed excluded, and ISS-4768
 * extends that to the desktop-reported legacy blob), while the LOC lane
 * ({@link sessionOutputDiffDisplay}) resolves the session's own authored diff or
 * the branch-level diff and Linked artifacts resolves slug links — neither of which
 * requires an authored PR. So a session that committed code and referenced
 * artifacts, but whose PR links all resolved to Referenced/Reviewed, renders a
 * non-zero "Lines changed" beside "Pull requests: None", and the two read as a
 * contradiction: "None" is taken to mean nothing was delivered.
 *
 * The fix is one word in the row that is actually ambiguous (design review). The
 * empty PR row does not mean "no PRs touched this session" — it means "no PRs
 * this session AUTHORED", which is exactly what the lane computes. Naming that
 * makes the two facts reconcile without either row growing a clause, and it
 * un-learns the wrong read at the place the reader forms it rather than three
 * rows below.
 *
 * Deliberately NOT a provenance claim about the LOC figure. An empty list is a
 * statement about this row's own contents; it is not evidence the change came
 * from no PR, and the detail payload carries nothing that could establish that —
 * `authoredPrLinesChanged` is zeroed by the SAME `headBranch === null` condition
 * that suppresses the PRs (`projections.ts`), so it cannot distinguish "authored
 * none" from "authored one that FEA-4188 suppressed". Rather than assert an
 * attribution we cannot support, the row narrows its own claim and the "Lines
 * changed" row keeps its untouched scope label.
 */
export const SESSION_EMPTY_PULL_REQUESTS_LABEL = "None authored" as const;

/**
 * ISS-5073: an event paired with everything the timeline derives from its
 * `createdAt`, so the sort, the grouping, and the group label all read from ONE
 * parse instead of re-tokenizing the same string on every comparison.
 *
 * `createdAtDate` is that single parsed `Date` (or `null` when `createdAt` could
 * not be parsed), carried forward so the per-GROUP label in `buildEventData` is
 * formatted from the same value `groupKey` was derived from — see the comment
 * there for why the label is not precomputed per event.
 */
type DecoratedSessionEvent = {
  event: SessionEvent;
  createdAtDate: Date | null;
  groupKey: string;
  sortKey: number;
};

/**
 * Parses `event.createdAt` once and derives the normalized `createdAt` string,
 * the `groupKey`, and the `sortKey` from that Date, retaining the Date itself as
 * `createdAtDate` so {@link buildEventData} can format the group label per GROUP
 * without re-parsing.
 *
 * An unparseable timestamp keeps the previous degraded shape: the event's own
 * `createdAt` renders as `"Unknown"`, it lands in the `"unknown"` group (whose
 * `"Unknown"` title is formatted in {@link buildEventData}), and it takes a 0
 * sort key — which places it last among the post-epoch timestamps real sessions
 * carry, under the newest-first ordering.
 */
function decorateSessionEvent(
  event: SyncedAgentSessionEvent,
  sessionId: string,
  agentNames: Map<string, string>
): DecoratedSessionEvent {
  const parsed = ensureDate(event.createdAt);
  const createdAt = parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
  return {
    event: {
      id: event.externalEventId,
      sessionId,
      agentId: event.agentExternalId,
      agentLabel: event.agentExternalId
        ? (agentNames.get(event.agentExternalId) ?? event.agentExternalId)
        : null,
      eventType: event.eventType,
      status: normalizeEventStatus(event),
      toolName: event.toolName,
      title: event.toolName ?? event.eventType,
      summary: event.summary,
      createdAt: createdAt ? createdAt.toISOString() : "Unknown",
      /* ISS-5074: no serialized `event.data` here. The timeline renders
       * `summary`/`metadata`/`detail` only, so pretty-printing every event's
       * payload cost the desktop renderer — which hydrates `data` from local
       * SQLite, unlike the cloud lane where FEA-2718 leaves it undefined — a
       * per-event string nothing reads.
       *
       * The `errors` lane still serializes, uncapped, one payload per error
       * event. Do NOT read that as "the errors payload is load-bearing":
       * `SessionErrorDetailsPanel`, its only consumer, is currently mounted
       * ONLY in `session-detail-panels.stories.tsx` — so that string is
       * unread by any shipped surface too. It is left alone here because
       * removing it is a separate change with its own blast radius, not
       * because anything renders it. */
      metadata: event.toolName
        ? [{ label: "Tool", value: event.toolName }]
        : undefined,
    },
    createdAtDate: createdAt,
    groupKey: getLocalCalendarDateKey(createdAt),
    sortKey: createdAt ? createdAt.getTime() : 0,
  };
}

/**
 * ISS-5131: the Duration MetricCard caption, derived from the SAME window that
 * produced the value it sits under — the repo rule that a status and its label
 * come from one helper, so two parallel switches cannot drift.
 *
 * The VALUE decides the absent branch, not the window alone: a measurable window
 * still yields no number when the start bound is missing or unparseable, and
 * captioning that empty slot "Start to end" would name the two bounds of a
 * measurement nothing made. Both Duration cards on this screen (the metric strip
 * and the Overview card) call this, so they can never state an absent span two
 * different ways.
 */
function resolveDurationCaption(
  window: SessionDurationWindow,
  value: string | null
): string {
  if (value === null) {
    return DURATION_UNRECORDED_DETAIL;
  }
  return resolveSessionDurationDetail(window) ?? DURATION_UNRECORDED_DETAIL;
}

/**
 * ISS-5131 (wongk, #4409): the "Ended" metadata value, read off the SAME
 * {@link SessionDurationWindow} the Duration cards used, so the two facts on one
 * screen cannot contradict each other.
 *
 * `running` says so regardless of whether a stale `endedAt` is still on the row;
 * `unmeasurable` — terminal with no end instant — states the absence rather than
 * borrowing "Still running", which claimed a lifecycle the status had already
 * ruled out. {@link END_UNRECORDED_VALUE} is deliberately its own string and not
 * {@link DURATION_UNRECORDED_DETAIL}: that one describes a missing LENGTH under
 * a Duration card, and this slot is a missing INSTANT.
 */
function resolveEndedMetadataValue(
  session: Pick<AgentSessionDetail, "endedAt">,
  window: SessionDurationWindow
): string {
  if (window.kind === "running") {
    return STILL_RUNNING_VALUE;
  }
  return session.endedAt
    ? safeFormatDateTime(session.endedAt)
    : END_UNRECORDED_VALUE;
}

/** The "Ended" metadata value for a session that has not been observed to end. */
const STILL_RUNNING_VALUE = "Still running";

/** The "Ended" metadata value for a terminal session carrying no end instant. */
const END_UNRECORDED_VALUE = "Not recorded";
