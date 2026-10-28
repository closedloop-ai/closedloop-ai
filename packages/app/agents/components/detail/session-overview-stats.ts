import type {
  AgentSessionDetail,
  SyncedAgentSessionEvent,
} from "@repo/api/src/types/agent-session";
import { resolveSessionDetailDurationWindow } from "@repo/app/agents/lib/session-detail-duration-window";
import {
  resolveSessionWallClockLabel,
  resolveSessionWallClockMs,
} from "@repo/app/agents/lib/session-duration";
import type { SessionOverviewStats } from "@repo/app/agents/lib/session-types";
import {
  isSessionMainAgent,
  resolveSubagentCount,
} from "@repo/app/agents/lib/subagent-transcripts";
import { formatNumber } from "@repo/app/shared/lib/format-utils";
import { normalizeDateTimeString } from "./session-datetime-format";
import {
  EVENT_RATE_UNAVAILABLE,
  resolveDurationCaption,
} from "./session-detail-captions";

/**
 * ISS-4677: cap on the Overview "Subagent types" tally, mirroring the
 * `topTools.slice(0, 6)` treatment — a busiest-first shortlist, not an
 * unbounded dump of every distinct type in Map insertion order.
 */
const MAX_SUBAGENT_TYPE_ENTRIES = 8;

export function buildOverviewStats(
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
    // (`apps/api/app/agent-sessions/service/session-slice-detail-write.ts` and
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
        }
      : null,
  };
}

export function buildToolInvocations(events: SyncedAgentSessionEvent[]) {
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
