import type {
  AgentSessionDetail,
  SyncedAgentSessionTokenUsage,
  TurnActor,
} from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { extractCodexRuntimeMetadata } from "../codex-runtime-metadata";
import { buildSessionDetailContent } from "../detail-content";
import { deriveCacheWriteTtlBreakdown } from "../session-cache-write-ttl";
import {
  buildTraceGroups,
  type SessionTraceItem,
  type TraceGroup,
} from "../session-trace-groups";

/**
 * ISS-7040 characterization suite. Every literal below was derived from the
 * pre-split implementations and must survive the decomposition byte-for-byte —
 * a value that changes here is a behavior change, not a refactor. Regenerating
 * an expectation from the post-split code would make this suite vacuous, so
 * these stay hand-written.
 *
 * It DELIBERATELY overlaps three existing suites, which keep their own coverage
 * and are not superseded: `detail-content.test.ts` (cache-write TTL, Codex
 * runtime metadata), `detail-content-event-groups.test.ts` (event ordering and
 * bucketing), and `detail-content-subagent-types.test.ts` (the subagent tally).
 * Those assert those contracts through their own callers; this file is the
 * single ISS-7040 oracle
 * that pins all five decomposed domains against ONE fixture set, so a reviewer
 * can read the split's behavioral contract in one place. The trace-ordering
 * block is not duplicated anywhere — `buildTraceGroups` had no direct unit
 * coverage before this suite, only indirect coverage through rendered-component
 * tests.
 *
 * Timestamps in the event fixtures are spaced a full 24h apart at the same wall
 * clock: `getLocalCalendarDateKey` buckets on the LOCAL calendar day, so a
 * narrower gap collapses two buckets into one at eastern UTC offsets and the
 * grouping assertions would pass only in the authoring timezone.
 */

const HUMAN_ACTOR: TurnActor = {
  name: null,
  sessionId: "session-detail-1",
  human: "Ada Lovelace",
  color: "hsl(210 65% 45%)",
};

const AGENT_ACTOR: TurnActor = {
  name: "gpt-5.5",
  sessionId: "session-detail-1",
  human: null,
  color: "var(--primary)",
  harness: "codex",
};

const OTHER_SESSION_AGENT_ACTOR: TurnActor = {
  ...AGENT_ACTOR,
  sessionId: "session-detail-2",
};

const TRACE_BASE_MS = Date.parse("2026-06-10T12:00:00.000Z");

function sayItem(
  row: number,
  offsetSeconds: number,
  text: string,
  overrides: Partial<Extract<SessionTraceItem, { type: "say" }>> = {}
): SessionTraceItem {
  const tMs = TRACE_BASE_MS + offsetSeconds * 1000;
  return {
    type: "say",
    _row: row,
    t: new Date(tMs).toISOString(),
    tMs,
    cum: 0,
    actor: AGENT_ACTOR,
    model: "claude-opus-4-8",
    text,
    ...overrides,
  } as SessionTraceItem;
}

function promptItem(
  row: number,
  offsetSeconds: number,
  text: string
): SessionTraceItem {
  const tMs = TRACE_BASE_MS + offsetSeconds * 1000;
  return {
    type: "prompt",
    _row: row,
    t: new Date(tMs).toISOString(),
    tMs,
    cum: 0,
    actor: HUMAN_ACTOR,
    text,
  } as SessionTraceItem;
}

/**
 * The rowless groups — the terminal `end` and an `idle` span, which describes
 * the pause BETWEEN two rows (ISS-8652) — carry no row, so narrow rather than
 * cast.
 */
function rowsOf(groups: readonly TraceGroup[]): Array<number | null> {
  return groups.map((group) =>
    group.kind === "end" || group.kind === "idle" ? null : group.row
  );
}

function usageRow(
  overrides: Partial<SyncedAgentSessionTokenUsage>
): SyncedAgentSessionTokenUsage {
  return {
    model: "claude-opus-4-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    ...overrides,
  } as SyncedAgentSessionTokenUsage;
}

describe("ISS-7040 tokens: cache-write TTL split", () => {
  it("sums the reported 5m/1h split across models", () => {
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({ cacheWrite5mTokens: 100, cacheWrite1hTokens: 25 }),
        usageRow({ model: "gpt-5.5", cacheWrite5mTokens: 40 }),
      ])
    ).toEqual({ ephemeral5mInputTokens: 140, ephemeral1hInputTokens: 25 });
  });

  it("floors fractional counts and discards negatives", () => {
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({ cacheWrite5mTokens: 10.9, cacheWrite1hTokens: -5 }),
      ])
    ).toEqual({ ephemeral5mInputTokens: 10, ephemeral1hInputTokens: 0 });
  });

  it("returns null when no model reported a split, and when the split is all zero", () => {
    expect(deriveCacheWriteTtlBreakdown(undefined)).toBeNull();
    expect(deriveCacheWriteTtlBreakdown([usageRow({})])).toBeNull();
    expect(
      deriveCacheWriteTtlBreakdown([
        usageRow({ cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }),
      ])
    ).toBeNull();
  });
});

describe("ISS-7040 tokens: Codex runtime metadata", () => {
  it("reads the freshest well-formed snapshot and clamps utilization", () => {
    expect(
      extractCodexRuntimeMetadata({
        modelContextWindow: 1000,
        codexLastTokenUsage: [
          {
            lastTokenUsage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
          {
            lastTokenUsage: {
              input: 100,
              output: 50,
              cacheRead: 25,
              cacheWrite: 25,
            },
          },
        ],
      })
    ).toEqual({
      modelContextWindow: 1000,
      latestTokenUsage: {
        input: 100,
        output: 50,
        cacheRead: 25,
        cacheWrite: 25,
        total: 200,
      },
      contextWindowUtilizationPercent: 20,
      rateLimits: null,
    });
  });

  it("falls back past a trailing malformed or all-zero snapshot", () => {
    expect(
      extractCodexRuntimeMetadata({
        codexLastTokenUsage: [
          {
            lastTokenUsage: {
              input: 7,
              output: 3,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
          {
            lastTokenUsage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
          { notASnapshot: true },
        ],
      })?.latestTokenUsage
    ).toEqual({
      input: 7,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      total: 10,
    });
  });

  it("clamps a rate-limit percent to [0,100] and nulls malformed members", () => {
    expect(
      extractCodexRuntimeMetadata({
        codexRateLimits: {
          primary: {
            used_percent: 140,
            window_minutes: 300,
            resets_at: 1_700_000_000,
          },
          secondary: { used_percent: -4 },
        },
      })?.rateLimits
    ).toEqual({
      primary: {
        usedPercent: 100,
        windowMinutes: 300,
        resetsAtEpochSeconds: 1_700_000_000,
      },
      secondary: {
        usedPercent: 0,
        windowMinutes: null,
        resetsAtEpochSeconds: null,
      },
    });
  });

  it("returns null when none of the three signals is present", () => {
    expect(extractCodexRuntimeMetadata(null)).toBeNull();
    expect(extractCodexRuntimeMetadata({ branch: "main" })).toBeNull();
  });

  it("leaves utilization null when either operand is missing", () => {
    expect(
      extractCodexRuntimeMetadata({ modelContextWindow: 1000 })
        ?.contextWindowUtilizationPercent
    ).toBeNull();
  });
});

describe("ISS-7040 events: ordering, grouping, and facets", () => {
  const session = createAgentSessionDetailFixture({
    events: [
      {
        externalEventId: "e-old",
        agentExternalId: "agent-main",
        eventType: "session_started",
        summary: "start",
        createdAt: "2026-06-09T12:02:00.000Z",
      },
      {
        externalEventId: "e-new",
        agentExternalId: "agent-main",
        eventType: "tool_use",
        toolName: "rg",
        summary: "search",
        createdAt: "2026-06-10T12:02:00.000Z",
      },
      {
        externalEventId: "e-bad",
        agentExternalId: null,
        eventType: "error",
        summary: "boom",
        createdAt: "not-a-timestamp",
      },
    ],
  });

  const eventData = buildSessionDetailContent(session).eventData;

  it("orders newest-first and sinks an unparseable timestamp last", () => {
    expect(
      eventData.groups.flatMap((group) => group.events.map((event) => event.id))
    ).toEqual(["e-new", "e-old", "e-bad"]);
  });

  it("buckets by LOCAL calendar day and files an unparseable stamp under 'unknown'", () => {
    expect(eventData.groups.map((group) => group.id)).toEqual([
      "2026-06-10",
      "2026-06-09",
      "unknown",
    ]);
    expect(eventData.groups.at(-1)?.title).toBe("Unknown");
  });

  it("normalizes each event's status from its type", () => {
    expect(
      eventData.groups.flatMap((group) =>
        group.events.map((event) => event.status)
      )
    ).toEqual(["working", "working", "error"]);
  });

  it("renders an unparseable createdAt as the 'Unknown' label, never a lie", () => {
    const unknownEvent = eventData.groups
      .flatMap((group) => group.events)
      .find((event) => event.id === "e-bad");
    expect(unknownEvent?.createdAt).toBe("Unknown");
  });

  it("derives facets from the decorated events and starts with an empty filter", () => {
    expect(eventData.facets.statuses).toEqual(["working", "error"]);
    expect(eventData.facets.eventTypes).toEqual([
      "tool_use",
      "session_started",
      "error",
    ]);
    expect(eventData.facets.toolNames).toEqual(["rg"]);
    expect(eventData.activeFilters).toEqual({
      query: "",
      statuses: [],
      eventTypes: [],
      toolNames: [],
      agents: [],
    });
  });
});

describe("ISS-7040 agents: subagent tally and overview reconciliation", () => {
  it("excludes the root main row, ranks busiest-first, and ties break by label", () => {
    const overview = buildSessionDetailContent(
      createAgentSessionDetailFixture({
        agents: [
          {
            externalAgentId: "root",
            name: "main",
            type: "main",
            status: "completed",
            task: null,
            currentTool: null,
            startedAt: "2026-06-10T12:00:00.000Z",
            updatedAt: "2026-06-10T12:00:00.000Z",
            endedAt: null,
            parentExternalAgentId: null,
          },
          ...["review", "review", "visual", "compaction"].map(
            (subagentType, index) => ({
              externalAgentId: `sub-${index}`,
              name: `worker-${index}`,
              type: "subagent",
              subagentType,
              status: "completed",
              task: null,
              currentTool: null,
              startedAt: "2026-06-10T12:00:00.000Z",
              updatedAt: "2026-06-10T12:00:00.000Z",
              endedAt: null,
              parentExternalAgentId: "root",
            })
          ),
        ] as AgentSessionDetail["agents"],
      })
    ).overview;

    expect(overview.subagentTypes).toEqual([
      { label: "review", count: 2, isCompaction: false },
      { label: "compaction", count: 1, isCompaction: true },
      { label: "visual", count: 1, isCompaction: false },
    ]);
    expect(overview.compactions).toBe(1);
    expect(overview.subagentTypesAvailable).toBe(true);
    expect(overview.subagentTypesOmitted).toBe(0);
    expect(overview.subagentTypesOmittedAgentCount).toBe(0);
  });

  it("caps the tally at 8 types and states the remainder in BOTH units", () => {
    const overview = buildSessionDetailContent(
      createAgentSessionDetailFixture({
        agents: Array.from({ length: 10 }, (_unused, index) => ({
          externalAgentId: `sub-${index}`,
          name: `worker-${index}`,
          type: "subagent",
          subagentType: `type-${index}`,
          status: "completed",
          task: null,
          currentTool: null,
          startedAt: "2026-06-10T12:00:00.000Z",
          updatedAt: "2026-06-10T12:00:00.000Z",
          endedAt: null,
          parentExternalAgentId: "root",
        })) as AgentSessionDetail["agents"],
      })
    ).overview;

    expect(overview.subagentTypes).toHaveLength(8);
    expect(overview.subagentTypesOmitted).toBe(2);
    expect(overview.subagentTypesOmittedAgentCount).toBe(2);
  });

  it("keeps 'unknown' unknown when the session reports no agents at all", () => {
    const overview = buildSessionDetailContent(
      createAgentSessionDetailFixture({ agents: [] })
    ).overview;

    expect(overview.subagents).toBeNull();
    expect(overview.subagentTypesAvailable).toBe(false);
  });
});

describe("ISS-7040 trace ordering: group coalescing", () => {
  it("coalesces consecutive same-side, same-session turns into ONE bubble", () => {
    const groups = buildTraceGroups([
      sayItem(0, 0, "first"),
      sayItem(1, 10, "second"),
      sayItem(2, 20, "third"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("msg");
    expect(rowsOf(groups)).toEqual([0]);
  });

  it("breaks the bubble on a side change and preserves source order", () => {
    const groups = buildTraceGroups([
      promptItem(0, 0, "ask"),
      sayItem(1, 10, "answer"),
      sayItem(2, 20, "more"),
      promptItem(3, 30, "follow up"),
    ]);
    expect(rowsOf(groups)).toEqual([0, 1, 3]);
    expect(
      groups.map((group) => (group.kind === "msg" ? group.side : group.kind))
    ).toEqual(["human", "agent", "human"]);
  });

  it("breaks the bubble on a session change even when the side matches", () => {
    const groups = buildTraceGroups([
      sayItem(0, 0, "parent"),
      sayItem(1, 10, "child", { actor: OTHER_SESSION_AGENT_ACTOR }),
    ]);
    expect(groups).toHaveLength(2);
    expect(rowsOf(groups)).toEqual([0, 1]);
  });

  it("drops idle, sessionstart, and whitespace-only turns without shifting order", () => {
    const groups = buildTraceGroups([
      { type: "sessionstart", _row: 0, t: "", tMs: TRACE_BASE_MS, cum: 0 },
      sayItem(1, 10, "   "),
      { type: "idle", _row: 2, t: "", tMs: TRACE_BASE_MS, cum: 0 },
      sayItem(3, 30, "real"),
    ] as SessionTraceItem[]);
    expect(groups).toHaveLength(1);
    expect(rowsOf(groups)).toEqual([3]);
  });

  it("gives a reasoning turn its own bubble and drops a redacted one", () => {
    const groups = buildTraceGroups([
      sayItem(0, 0, "response"),
      sayItem(1, 10, "  ", { isThinking: true }),
      sayItem(2, 20, "thinking out loud", { isThinking: true }),
      sayItem(3, 30, "more response"),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["msg", "reason", "msg"]);
    expect(rowsOf(groups)).toEqual([0, 2, 3]);
  });

  it("accumulates cost across a coalesced bubble and keeps the LAST cumulative", () => {
    const groups = buildTraceGroups([
      sayItem(0, 0, "one", { cum: 1, costDelta: 0.25 }),
      sayItem(1, 10, "two", { cum: 1.75, costDelta: 0.75 }),
    ]);
    const group = groups[0];
    expect(group?.kind).toBe("msg");
    if (group?.kind === "msg") {
      expect(group.cumulativeCost).toBe(1.75);
      expect(group.costDelta).toBe(1);
      expect(group.segments).toHaveLength(2);
    }
  });
});
