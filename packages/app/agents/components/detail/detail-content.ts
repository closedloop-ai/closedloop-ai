import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  LOC_METRIC_DEFINITION,
  LocMetricDefinitionId,
} from "@repo/api/src/types/loc-metric-definitions";
import {
  locPerDollarFromLines,
  locPerDollarNumeratorLines,
  resolveLocPerDollar,
} from "@repo/api/src/utils/loc-per-dollar";
import {
  CostAvailability,
  deriveCostAvailability,
  formatCostLabel,
  getCostTooltip,
} from "@repo/app/agents/lib/cost-availability";
import { resolveSessionDetailDurationWindow } from "@repo/app/agents/lib/session-detail-duration-window";
import { resolveSessionWallClockLabel } from "@repo/app/agents/lib/session-duration";
import { resolveSessionRepositoryLabel } from "@repo/app/agents/lib/session-repository-label";
import {
  formatCost,
  formatLocPerDollar,
  formatNumber,
  formatTokenCount,
  KPI_NO_VALUE,
} from "@repo/app/shared/lib/format-utils";
import { buildSessionAgents } from "./agent-tree-utils";
import { safeFormatDateTime } from "./session-datetime-format";
import {
  resolveDurationCaption,
  resolveEndedMetadataValue,
} from "./session-detail-captions";
import { buildEventData } from "./session-event-groups";
import {
  buildOverviewStats,
  buildToolInvocations,
} from "./session-overview-stats";

export type AgentSessionDetailContent = ReturnType<
  typeof buildSessionDetailContent
>;

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
        label:
          LOC_METRIC_DEFINITION[LocMetricDefinitionId.SessionDetailMergedLoc]
            .label,
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
      // ISS-5131 (whitlockk, #4409): derived from the SAME window the Duration cards
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
    ],
    details: [
      { label: "Worktree", value: session.worktreePath ?? "Unknown" },
      { label: "CWD", value: session.cwd ?? "Unknown" },
      { label: "Base branch", value: session.baseBranch ?? "Unknown" },
      {
        label: "Source artifact",
        value: session.sourceArtifactId ?? "None",
      },
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
 * FEA-3630 / FEA-4250 / ISS-4667: per-session LOC/$ (cost-efficiency) — lines of
 * code delivered per dollar spent. Mirrors the org-level
 * `AgentSessionUsageSummary.mergedLocPerDollar` but for a single session:
 *
 *   locPerDollar = mergedAuthoredPrLinesChanged / estimatedCost
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
 * Local fallback (ISS-9964 / ISS-9980, RULED 2026-09-11): the numerator is
 * {@link locPerDollarNumeratorLines} — the lines landed in MERGED authored PRs,
 * and the SAME derivation the "Lines changed" row beside it renders, so the two
 * cannot disagree. The working-tree and branch-diff rungs FEA-4378/ISS-4448
 * added are retired rather than re-homed: the session `linesAdded/linesRemoved`
 * scalars are transcript-derived (FEA-3922/FEA-3923) and fold delegated
 * sub-agent churn in (ISS-5402), and the branch diff spans sessions this one did
 * not author — neither measures code this session delivered.
 *
 * A `null` numerator is NOT KNOWABLE, not zero: a session that merged nothing
 * yields a measured `0` and divides. `null` propagates so the UI renders the
 * not-applicable placeholder rather than a fabricated ratio. The lines/cost
 * ratio and its guards are the shared SSOT {@link locPerDollarFromLines}.
 */
export function computeSessionLocPerDollar(
  session: Pick<
    AgentSessionDetail,
    | "locPerDollar"
    | "klocPerDollar"
    | "mergedAuthoredPrLinesChanged"
    | "authoredPrLinesChanged"
  > & {
    estimatedCost: number | null;
  }
): number | null {
  if (
    session.locPerDollar !== undefined ||
    session.klocPerDollar !== undefined
  ) {
    return resolveLocPerDollar(session.locPerDollar, session.klocPerDollar);
  }
  return locPerDollarFromLines(
    locPerDollarNumeratorLines(session),
    session.estimatedCost
  );
}

/**
 * ISS-4667: display string for the per-session LOC/$ efficiency metric via the
 * shared {@link formatLocPerDollar} — adaptive precision (a genuinely small but
 * non-zero ratio never floors to `0.00`) and the distinct not-applicable
 * placeholder when the ratio is undefined ($0 cost / no lines).
 */
export function formatSessionLocPerDollar(
  session: Pick<
    AgentSessionDetail,
    | "locPerDollar"
    | "klocPerDollar"
    | "mergedAuthoredPrLinesChanged"
    | "authoredPrLinesChanged"
  > & {
    estimatedCost: number | null;
  }
): string {
  return formatLocPerDollar(computeSessionLocPerDollar(session));
}
