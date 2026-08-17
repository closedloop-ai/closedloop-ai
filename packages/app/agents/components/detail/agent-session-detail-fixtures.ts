import {
  type ActivityBucket,
  type AgentSessionDetail,
  AgentSessionOrigin,
  AgentSessionState,
  type SessionMarker,
  type TurnActor,
  type TurnItem,
} from "@repo/api/src/types/agent-session";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionTraceItem } from "./session-trace";

const BASE_TIME = "2026-06-10T12:00:00.000Z";

export function createAgentSessionDetailFixture(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  const agentActor = {
    name: "gpt-5.5",
    sessionId: "session-detail-1",
    human: null,
    color: "var(--primary)",
    harness: "codex",
  };
  const humanActor = {
    name: null,
    sessionId: "session-detail-1",
    human: "Ada Lovelace",
    color: "hsl(210 65% 45%)",
  };
  const session: AgentSessionDetail = {
    id: "session-detail-1",
    slug: "SES-1",
    externalSessionId: "ext-session-1",
    name: "Desktop implementation session",
    status: SESSION_STATUS.INACTIVE,
    origin: AgentSessionOrigin.DesktopSync,
    state: AgentSessionState.Completed,
    harness: "codex",
    cwd: "repos/symphony-alpha",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    repo: "closedloop-ai/symphony-alpha",
    worktreePath: "worktrees/symphony-alpha-fea-1707",
    model: "gpt-5.5",
    primaryModel: "gpt-5.5",
    models: ["gpt-5.5"],
    branch: "fea-1707",
    prs: [],
    prsMerged: 0,
    cost: "$4.82",
    wallClock: "20m",
    activeAgent: "18m",
    waitingUser: null,
    linesAdded: 120,
    linesRemoved: 12,
    filesChanged: 4,
    turns: 8,
    toolCallsTotal: 5,
    steeringEpisodes: 1,
    autonomy: 82,
    tokensIn: 12_000,
    tokensOut: 3200,
    cache: 900,
    cacheWrite: 400,
    userColor: "hsl(210 65% 45%)",
    activityBuckets: [],
    span: null,
    markers: [],
    throttles: [],
    phases: [],
    phaseIterations: {},
    phaseLoopbacks: [],
    startedAt: new Date(BASE_TIME),
    updatedAt: new Date("2026-06-10T12:18:00.000Z"),
    lastActivityAt: new Date("2026-06-10T12:18:00.000Z"),
    lastSyncedAt: new Date("2026-06-10T12:19:00.000Z"),
    endedAt: new Date("2026-06-10T12:20:00.000Z"),
    awaitingInputSince: null,
    inputTokens: 12_000,
    outputTokens: 3200,
    cacheReadTokens: 900,
    cacheWriteTokens: 400,
    estimatedCost: 4.82,
    agentCount: 3,
    toolUseCount: 5,
    errorCount: 1,
    baseBranch: "main",
    sourceArtifactId: "FEA-1707",
    sourceArtifact: {
      id: "artifact-1",
      name: "Shared Agent Sessions Detail Foundation",
      slug: "FEA-1707",
      documentType: null,
    },
    sourceLoopId: "loop-1",
    user: {
      id: "user-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      avatarUrl: null,
    },
    computeTarget: {
      id: "target-1",
      machineName: "Ada's MacBook",
      isOnline: true,
      lastSeenAt: new Date("2026-06-10T12:21:00.000Z"),
      lastAgentSessionSyncAt: new Date("2026-06-10T12:19:00.000Z"),
    },
    project: {
      id: "project-1",
      name: "Desktop MLP",
      slug: "PRO-1",
    },
    metadata: {
      branch: "fea-1707",
      validation: "rendered-screen",
    },
    tokenUsageByModel: [
      {
        model: "gpt-5.5",
        inputTokens: 12_000,
        outputTokens: 3200,
        cacheReadTokens: 900,
        cacheWriteTokens: 400,
        estimatedCostUsd: 4.82,
      },
    ],
    attribution: {
      repositoryFullName: "closedloop-ai/symphony-alpha",
      worktreePath: "worktrees/symphony-alpha-fea-1707",
      sourceArtifactId: "FEA-1707",
      sourceLoopId: "loop-1",
      baseBranch: "main",
    },
    agents: [
      {
        externalAgentId: "agent-main",
        name: "Implementation worker",
        type: "main",
        status: "completed",
        task: "Extract the shared detail foundation.",
        currentTool: null,
        startedAt: BASE_TIME,
        updatedAt: "2026-06-10T12:18:00.000Z",
        endedAt: "2026-06-10T12:20:00.000Z",
        parentExternalAgentId: null,
      },
      {
        externalAgentId: "agent-review",
        name: "Review lane",
        type: "subagent",
        subagentType: "review",
        status: "failed",
        task: "Verify import ownership and state coverage.",
        currentTool: null,
        startedAt: "2026-06-10T12:04:00.000Z",
        updatedAt: "2026-06-10T12:12:00.000Z",
        endedAt: "2026-06-10T12:12:00.000Z",
        parentExternalAgentId: "agent-main",
      },
      {
        externalAgentId: "agent-ui",
        name: "Rendered UI checker",
        type: "subagent",
        subagentType: "visual",
        status: "completed",
        task: "Capture Storybook screenshots.",
        currentTool: "playwright",
        startedAt: "2026-06-10T12:08:00.000Z",
        updatedAt: "2026-06-10T12:17:00.000Z",
        endedAt: "2026-06-10T12:17:00.000Z",
        parentExternalAgentId: "agent-main",
      },
    ],
    events: [
      {
        externalEventId: "event-1",
        agentExternalId: "agent-main",
        eventType: "session_started",
        summary: "Implementation started.",
        createdAt: BASE_TIME,
      },
      {
        externalEventId: "event-2",
        agentExternalId: "agent-main",
        eventType: "tool_use",
        toolName: "rg",
        summary: "Inspected current detail callers.",
        data: { pattern: "AgentSessionDetailView" },
        createdAt: "2026-06-10T12:02:00.000Z",
      },
      {
        externalEventId: "event-3",
        agentExternalId: "agent-review",
        eventType: "error",
        toolName: "vitest",
        summary: "Review lane found an import ownership issue.",
        data: { file: "packages/app/agents/components/detail/example.tsx" },
        createdAt: "2026-06-10T12:12:00.000Z",
      },
      {
        externalEventId: "event-4",
        agentExternalId: "agent-ui",
        eventType: "tool_use",
        toolName: "playwright",
        summary: "Captured desktop and mobile screenshots.",
        createdAt: "2026-06-10T12:17:00.000Z",
      },
    ],
    timeline: [
      {
        t: "2026-06-10T12:02:00.000Z",
        tMs: Date.parse("2026-06-10T12:02:00.000Z"),
        kind: "tool",
        title: "rg",
        tl: 0,
      },
      {
        t: "2026-06-10T12:12:00.000Z",
        tMs: Date.parse("2026-06-10T12:12:00.000Z"),
        kind: "tool",
        title: "vitest",
        err: true,
        tl: 1,
      },
    ],
    turnItems: [
      {
        type: "prompt",
        _row: 0,
        t: "2026-06-10T12:01:00.000Z",
        tMs: Date.parse("2026-06-10T12:01:00.000Z"),
        cum: 0,
        actor: humanActor,
        text: "Please inspect the shared session detail screen.",
      },
      {
        type: "say",
        _row: 1,
        t: "2026-06-10T12:01:20.000Z",
        tMs: Date.parse("2026-06-10T12:01:20.000Z"),
        cum: 0.003,
        costDelta: 0.003,
        actor: agentActor,
        isThinking: true,
        model: "gpt-5.5",
        text: "The dashboard mixes metrics and transcript; a dedicated trace view reads better.",
      },
      {
        type: "say",
        _row: 2,
        t: "2026-06-10T12:01:30.000Z",
        tMs: Date.parse("2026-06-10T12:01:30.000Z"),
        cum: 0.063,
        costDelta: 0.06,
        actor: agentActor,
        model: "gpt-5.5",
        text: "I will replace the details dashboard with a Session Trace workspace.",
      },
      {
        type: "tools",
        _row: 3,
        t: "2026-06-10T12:02:00.000Z",
        tMs: Date.parse("2026-06-10T12:02:00.000Z"),
        endMs: Date.parse("2026-06-10T12:03:00.000Z"),
        cum: 1.293,
        costDelta: 1.23,
        actor: agentActor,
        summary: "Ran 2 tools",
        items: [
          { label: "rg", detail: "AgentSessionDetailView", err: false },
          { label: "vitest", detail: "detail view coverage", err: true },
        ],
        hasFail: true,
        failN: 1,
        defaultOpen: true,
        cats: { tool: 2 },
      },
      {
        type: "event",
        _row: 4,
        t: "2026-06-10T12:03:30.000Z",
        tMs: Date.parse("2026-06-10T12:03:30.000Z"),
        dot: "g",
        text: "Initial implementation checkpoint after #3.",
        tag: "checkpoint",
      },
      {
        type: "subagent",
        _row: 5,
        t: "2026-06-10T12:04:00.000Z",
        tMs: Date.parse("2026-06-10T12:04:00.000Z"),
        cum: 2.403,
        costDelta: 1.11,
        actor: agentActor,
        sub: "Review lane",
        subagentType: "review",
        status: "failed",
        model: "gpt-5.5",
        duration: "8m",
        tokens: null,
        cost: null,
        body: [
          {
            kind: "task",
            text: "Verify import ownership and state coverage.",
          },
          {
            kind: "tool",
            text: "vitest",
            t: "2026-06-10T12:12:00.000Z",
            err: true,
          },
          {
            kind: "status",
            text: "failed",
            t: "2026-06-10T12:12:00.000Z",
            err: true,
          },
        ],
      },
      {
        type: "end",
        text: "Session completed.",
      },
    ],
    ...overrides,
  };

  return {
    ...session,
    agentCount: overrides.agents?.length ?? session.agents.length,
    toolUseCount:
      overrides.events?.filter((event) => event.toolName).length ??
      session.toolUseCount,
    errorCount:
      overrides.events?.filter((event) =>
        event.eventType.toLowerCase().includes("error")
      ).length ?? session.errorCount,
  };
}

export const populatedAgentSessionDetailFixture =
  createAgentSessionDetailFixture();

export const emptyAgentsAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Empty agent session",
    agents: [],
    events: [],
    timeline: [],
    turnItems: [],
  });

export const noErrorAgentSessionDetailFixture = createAgentSessionDetailFixture(
  {
    name: "No-error session",
    agents: populatedAgentSessionDetailFixture.agents.map((agent) => ({
      ...agent,
      status: "completed",
    })),
    events: populatedAgentSessionDetailFixture.events.filter(
      (event) => !event.eventType.toLowerCase().includes("error")
    ),
  }
);

export const errorChainAgentSessionDetailFixture =
  createAgentSessionDetailFixture();

export const nullDateAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Null date session",
    endedAt: null,
    agents: populatedAgentSessionDetailFixture.agents.map((agent) => ({
      ...agent,
      startedAt: agent.externalAgentId === "agent-review" ? "not-a-date" : null,
      endedAt: null,
    })),
  });

export const longContentAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "A very long shared agent session detail title that must wrap cleanly without overlapping adjacent controls",
    worktreePath:
      "worktrees/symphony-alpha-fea-1707/packages/app/agents/components/detail/with/a/very/long/path/that/should/not/clip",
    events: populatedAgentSessionDetailFixture.events.map((event) => ({
      ...event,
      summary:
        "This event summary is intentionally long to verify wrapping and scrolling behavior in the timeline and tooltip surfaces without clipped readable content.",
    })),
  });

/**
 * ISS-5075: the detail read hit its event-row ceiling, so `events` (and the
 * `timeline`/`turnItems` derived from them) are a chronological PREFIX. No
 * transcript context, so the panel paints this DB projection — the one source
 * the cap truncates — and all three disclosures show: the Session Timeline note,
 * the trace-header qualifier, and the end-of-trace footer.
 */
export const truncatedEventsAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Truncated event stream session",
    eventsTruncated: true,
  });

/**
 * ISS-5075: the SAME flag, over a session whose archived transcript is the
 * rendered trace. The header qualifier still prints — that count is the capped
 * DB projection whatever the panel painted — while the end-of-trace footer stays
 * OFF, because that note claims the ROWS on screen stop early and a parsed
 * transcript is read whole. The Session Timeline note stays too: that strip is
 * plotted from the capped projection either way.
 */
export const truncatedEventsWithTranscriptAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Truncated event stream with archived transcript",
    eventsTruncated: true,
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: "2026-08-04T13:35:00.000Z",
        permanentFailureReason: null,
      },
    ],
  });

/**
 * ISS-4654: a session carrying a `state` this build has no entry for — what an
 * installed client sees once the server emits an `AgentSessionState` member
 * added after that build shipped. No such member is currently planned: the
 * `Inactive` one this used to cite was resolved as NOT NEEDED (2026-08-08).
 * The hazard is not hypothetical for that reason — it is the general
 * unversioned-wire-value case, and this fixture is what keeps the fallback
 * honest for whatever member is added next.
 *
 * The cast is the point, and it is why this cannot be expressed without one:
 * the TYPE is the closed set this build knows, and the WIRE is not. Per the
 * repo's own carve-out, a type boundary stops at a cross-version payload.
 *
 * Shared rather than re-declared: the render test, the copy-parity test, and
 * the Storybook story all need the same skewed session, and the state string
 * has to be one value or they stop describing the same scenario.
 */
export const UNRECOGNIZED_AGENT_SESSION_STATE =
  "INACTIVE_FROM_A_NEWER_SERVER" as AgentSessionDetail["state"];

export const unknownStateAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Session in a state this build does not recognize",
    state: UNRECOGNIZED_AGENT_SESSION_STATE,
  });

/**
 * The default `turnItems` re-timed so the PLOTTED rows span exactly
 * `[startedAt, endedAt]`, keeping their order, `_row` identity and relative
 * spacing.
 *
 * The Session Timeline measures the plotted-activity window
 * (`resolveSessionTimelineWindow`), not the lifecycle timestamps, so a fixture
 * that overrides only `startedAt`/`lastActivityAt`/`endedAt` leaves its
 * transcript describing a DIFFERENT window than the session claims — the axis
 * then honestly reports the rows' span and the test's declared window never
 * reaches the screen. Pair every lifecycle override that a timeline assertion
 * depends on with this helper so the fixture states one window, not two.
 *
 * A zero-length target collapses every row onto that single instant, which is
 * what a genuinely zero-duration session looks like. Rows carrying no plotted
 * instant (`idle`, `end`) and nested subagent body lines — which the timeline
 * does not plot — pass through untouched.
 */
export function createTurnItemsSpanning(
  startedAt: Date | string,
  endedAt: Date | string
): TurnItem[] {
  const items = createAgentSessionDetailFixture().turnItems ?? [];
  const sourceMs = items.filter(isPlottedTurnItem).map((item) => item.tMs);
  const sourceStartMs = Math.min(...sourceMs);
  const sourceSpanMs = Math.max(...sourceMs) - sourceStartMs;
  const targetStartMs = new Date(startedAt).getTime();
  const targetSpanMs = new Date(endedAt).getTime() - targetStartMs;
  const mapMs = (ms: number): number => {
    if (sourceSpanMs === 0) {
      return targetStartMs;
    }
    return Math.round(
      targetStartMs + ((ms - sourceStartMs) / sourceSpanMs) * targetSpanMs
    );
  };
  return items.map((item) => retimeTurnItem(item, mapMs));
}

/** The turn-item variants the Session Timeline plots, i.e. those with an instant. */
type PlottedTurnItem = Extract<TurnItem, { tMs: number }>;

/** A turn item the Session Timeline plots, i.e. one carrying an instant. */
function isPlottedTurnItem(item: TurnItem): item is PlottedTurnItem {
  return "tMs" in item;
}

/** One turn item with every instant it carries moved through `mapMs`. */
function retimeTurnItem(
  item: TurnItem,
  mapMs: (ms: number) => number
): TurnItem {
  if (!isPlottedTurnItem(item)) {
    return item;
  }
  const tMs = mapMs(item.tMs);
  const t = new Date(tMs).toISOString();
  if (item.type === "tools") {
    return { ...item, endMs: mapMs(item.endMs), t, tMs };
  }
  return { ...item, t, tMs };
}

/**
 * A marker in the wire shape a synced record can deserialize into: everything a
 * dot needs to render, and no `tl`.
 *
 * `SessionMarker.tl` is typed `number`, and the property is removed at runtime
 * rather than cast away — FEA-4114 bans the double cast outside test files, and
 * deleting the key reproduces the real shape more faithfully than lying about
 * the type would.
 */
function buildMarkerWithoutJumpRow(): SessionMarker {
  const marker = {
    kind: "commit" as const,
    x: 60,
    t: "2026-06-10T13:00:00.000Z",
    label: "commit with no resolvable turn",
    tl: 0,
  };
  Reflect.deleteProperty(marker, "tl");
  return marker;
}

/**
 * ISS-5479: the jump-feedback vocabulary, all of it visible at once.
 *
 * The strip carries an idle bucket (`tl0: null` — its time slice caught no
 * transcript turn) flanked on both sides by jumpable ones, so the withdrawn
 * affordance can be compared against a live control six pixels away rather than
 * described. The dot rail does the same: one lane holds a marker with a jump row
 * and one holds a marker without, which is the wire shape a synced marker can
 * deserialize into.
 *
 * Buckets are explicit rather than derived, because `buildActivityBuckets`
 * prefers `session.activityBuckets` when present — that is the only way to pin a
 * `tl0: null` bucket in a known position instead of hoping the time-bucketing
 * produces one.
 */
export const idleJumpTargetsAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Idle jump targets session",
    activityBuckets: [
      {
        key: "idle-story-0",
        label: "0m",
        cIn: 0.5,
        cOut: 0.3,
        cCache: 0.1,
        total: 4,
        toolStart: 2,
        tl0: 0,
        byModel: { "gpt-5.5": { cIn: 0.5, cOut: 0.3, cCache: 0.1 } },
      },
      {
        key: "idle-story-1",
        label: "45m",
        cIn: 0,
        cOut: 0,
        cCache: 0,
        total: 0,
        toolStart: 0,
        tl0: null,
        byModel: {},
      },
      {
        key: "idle-story-2",
        label: "90m",
        cIn: 0.4,
        cOut: 0.2,
        cCache: 0.1,
        total: 3,
        toolStart: 1,
        tl0: 1,
        byModel: { "gpt-5.5": { cIn: 0.4, cOut: 0.2, cCache: 0.1 } },
      },
    ],
    markers: [
      {
        kind: "prompt",
        x: 100,
        t: "2026-06-10T13:30:00.000Z",
        label: "steer past the first hour",
        tl: 1,
      },
      buildMarkerWithoutJumpRow(),
    ],
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    endedAt: new Date("2026-06-10T13:31:00.000Z"),
    updatedAt: new Date("2026-06-10T13:31:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:31:00.000Z"),
  });

/**
 * ISS-5548: the column hit target's two states side by side.
 *
 * The same bucket pair the unit and e2e tests use
 * (`e2e/session-timeline-column-hit-target.spec.ts`), so Storybook, jsdom and
 * Playwright all argue over one shape. The two bars differ on JUMPABILITY, not
 * on size — which is the whole axis the fix keys off, and the thing that is
 * impossible to see from the `.reach` class alone:
 *
 * - bucket 0 is a barely-visible spend (`getBarStyle` floors it at 9% of the
 *   column, about 6px) that CAN be jumped to, so it grows the full-column
 *   target and outlines that column on hover and on keyboard focus;
 * - bucket 1 is the LARGER of the two and has no transcript anchor, so it gains
 *   nothing — the flag can never manufacture a bigger dead target.
 *
 * Buckets are explicit rather than derived for the same reason as the fixture
 * above: `buildActivityBuckets` prefers `session.activityBuckets`, and that is
 * the only way to pin a `tl0: null` bucket in a known position.
 */
export const columnHitTargetAgentSessionDetailFixture =
  createAgentSessionDetailFixture({
    name: "Column hit target session",
    activityBuckets: [
      {
        key: "hit-target-story-0",
        label: "12:00",
        cIn: 0.001,
        cOut: 0.001,
        cCache: 0,
        total: 2,
        toolStart: 1,
        tl0: 0,
        byModel: { "gpt-5.5": { cIn: 0.001, cOut: 0.001, cCache: 0 } },
      },
      {
        key: "hit-target-story-1",
        label: "12:30",
        cIn: 0.4,
        cOut: 0.3,
        cCache: 0.2,
        total: 9,
        toolStart: 4,
        tl0: null,
        byModel: { "gpt-5.5": { cIn: 0.4, cOut: 0.3, cCache: 0.2 } },
      },
    ],
    startedAt: new Date("2026-06-10T12:00:00.000Z"),
    endedAt: new Date("2026-06-10T13:00:00.000Z"),
    updatedAt: new Date("2026-06-10T13:00:00.000Z"),
    lastActivityAt: new Date("2026-06-10T13:00:00.000Z"),
  });

/**
 * ISS-5698: the two actors every Session Trace fixture below shares.
 *
 * Coalescing is keyed on `(side, actor.sessionId)`, so a run of agent turns
 * carrying this one actor merges into a single bubble and a human turn between
 * them splits it. Every fixture that needs separate agent bubbles therefore
 * interleaves a human turn rather than inventing a second session id.
 */
const TRACE_AGENT_ACTOR: TurnActor = {
  name: "claude-opus-4-8",
  sessionId: "session-detail-1",
  human: null,
  color: "var(--primary)",
  harness: "claude",
};

const TRACE_HUMAN_ACTOR: TurnActor = {
  name: null,
  sessionId: "session-detail-1",
  human: "Ada Lovelace",
  color: "hsl(210 65% 45%)",
};

/** A human turn at `offsetSeconds` past {@link BASE_TIME}. */
function tracePromptItem(
  row: number,
  offsetSeconds: number,
  text: string
): SessionTraceItem {
  const tMs = Date.parse(BASE_TIME) + offsetSeconds * 1000;
  return {
    type: "prompt",
    _row: row,
    t: new Date(tMs).toISOString(),
    tMs,
    cum: 0,
    actor: TRACE_HUMAN_ACTOR,
    text,
  };
}

/** An agent turn at `offsetSeconds` past {@link BASE_TIME}. */
function traceSayItem(
  row: number,
  offsetSeconds: number,
  text: string,
  cost: { cum: number; costDelta?: number }
): SessionTraceItem {
  const tMs = Date.parse(BASE_TIME) + offsetSeconds * 1000;
  return {
    type: "say",
    _row: row,
    t: new Date(tMs).toISOString(),
    tMs,
    cum: cost.cum,
    ...(cost.costDelta === undefined ? {} : { costDelta: cost.costDelta }),
    actor: TRACE_AGENT_ACTOR,
    model: "claude-opus-4-8",
    text,
  };
}

/**
 * ISS-5698: the populated session's turns, typed as the Session Trace consumes
 * them. `AgentSessionDetail.turnItems` is optional, so every trace story would
 * otherwise repeat the same `?? []`.
 */
export const populatedSessionTraceItems: SessionTraceItem[] =
  populatedAgentSessionDetailFixture.turnItems ?? [];

/**
 * ISS-5698: an agent turn the producer flagged.
 *
 * `flag` lives on `SessionTraceItem`, the trace-only widening of `TurnItem`, so
 * no `AgentSessionDetail` fixture can carry one and the flag tag above the
 * bubble is unreachable from the parent-view stories.
 */
export const flaggedSessionTraceItems: SessionTraceItem[] = [
  tracePromptItem(0, 60, "Summarize what the reaper actually closed."),
  {
    ...traceSayItem(
      1,
      80,
      "Every one of the 24 reaped lanes hit the 600s watchdog, not host load.",
      { cum: 0.42, costDelta: 0.42 }
    ),
    flag: { reason: "Disputed: watchdog attribution" },
  },
];

/**
 * ISS-5698: the four cost readouts a turn gutter can produce, in one trace.
 *
 * The axis is whether a figure was MEASURED, and this pins all four answers so
 * they can be compared rather than reasoned about: a sub-cent delta that must
 * not floor to `$0.00`; a delta under the 4dp rounding floor, which states its
 * bound instead of fabricating a zero; a turn carrying no delta at all, which
 * falls back to the running total; and a turn that cost a measured nothing,
 * which prints NO figure rather than a `$0.00` that would read the same as
 * "never priced".
 */
export const traceCostReadoutItems: SessionTraceItem[] = [
  tracePromptItem(0, 0, "Walk the branch and price each step."),
  traceSayItem(1, 20, "Read the branch head and diffed it against main.", {
    cum: 1.2,
    costDelta: 0.0034,
  }),
  tracePromptItem(2, 40, "Now the smallest step you took."),
  traceSayItem(3, 60, "Re-read one cached file: a few tokens, no round trip.", {
    cum: 1.2,
    costDelta: 0.000_03,
  }),
  tracePromptItem(4, 80, "And the step the producer never priced."),
  traceSayItem(
    5,
    100,
    "Replayed the cached plan; this turn carries no delta.",
    {
      cum: 2.5,
    }
  ),
  tracePromptItem(6, 120, "Last one."),
  traceSayItem(7, 140, "Nothing billable happened in this turn.", {
    cum: 2.5,
    costDelta: 0,
  }),
];

/**
 * ISS-5698: an expandable tool card beside a degraded one, in the same bubble.
 *
 * The first card carries per-call rows, so it is a real disclosure. The second
 * came back from a producer that stripped per-call detail (the cloud DB path
 * keeps no event `data`), so it renders as a static summary with no chevron. A
 * dropdown that opens onto nothing is the defect this pairing guards. Neither
 * card has a failure, so both start CLOSED: the populated fixture's card
 * auto-opens on `hasFail`, which hides the collapsed default.
 */
export const traceToolCardItems: SessionTraceItem[] = [
  tracePromptItem(0, 0, "Typecheck the affected slice."),
  {
    type: "tools",
    _row: 1,
    t: new Date(Date.parse(BASE_TIME) + 20_000).toISOString(),
    tMs: Date.parse(BASE_TIME) + 20_000,
    endMs: Date.parse(BASE_TIME) + 74_000,
    cum: 0.31,
    costDelta: 0.31,
    actor: TRACE_AGENT_ACTOR,
    summary: "Ran 2 tools",
    items: [
      {
        label: "Bash",
        detail: "pnpm turbo typecheck",
        err: false,
        detailState: "available",
        input: "pnpm turbo typecheck --filter=...@repo/design-system",
        output: "Tasks:    44 successful, 44 total\nCached:   41 cached",
        durationMs: 54_000,
        status: "exit 0",
      },
      {
        label: "Read",
        detail: "packages/app/agents/components/detail/session-trace.tsx",
        err: false,
        detailState: "unavailable",
      },
    ],
    hasFail: false,
    failN: 0,
    cats: { bash: 1, read: 1 },
  },
  {
    type: "tools",
    _row: 2,
    t: new Date(Date.parse(BASE_TIME) + 80_000).toISOString(),
    tMs: Date.parse(BASE_TIME) + 80_000,
    endMs: Date.parse(BASE_TIME) + 92_000,
    cum: 0.31,
    actor: TRACE_AGENT_ACTOR,
    summary: "Ran 6 tools",
    items: [],
    hasFail: false,
    failN: 0,
    cats: { tool: 6 },
  },
];

/**
 * ISS-5698: prose that has to wrap and a token that cannot.
 *
 * The unbroken token is a real shape, a signed archive URL pasted into a turn,
 * and it is what pushes a bubble past its column when the trace renders narrow.
 * Paired with a long paragraph so wrapping and overflow are legible together.
 */
export const longTraceTextItems: SessionTraceItem[] = [
  tracePromptItem(
    0,
    0,
    "Here is the archive I was handed: https://closedloop-transcripts.s3.us-east-1.amazonaws.com/sessions/ext-session-1/main.jsonl?X-Amz-Signature=0f2c9a1b7d4e6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a"
  ),
  traceSayItem(
    1,
    20,
    "Read the archive end to end. It is a single JSONL stream whose records interleave the human turns, the assistant turns, and every tool call the harness made, which means the parser cannot assume a record boundary lines up with a turn boundary and has to carry a partial line across every chunk it reads. That constraint is why the streaming reader exists at all, and it is also why a truncated final line has to parse rather than abort the whole render.",
    { cum: 0.88, costDelta: 0.88 }
  ),
];

/**
 * ISS-5698: `count` alternating human/agent turns for the windowed trace.
 *
 * Long enough that windowing is the only reason the DOM stays small, and each
 * turn is individually identifiable so a story can prove a given row rendered
 * rather than only that something did.
 */
export function createSessionTraceItemsOfLength(
  count: number
): SessionTraceItem[] {
  const items: SessionTraceItem[] = [];
  for (let row = 0; row < count; row += 1) {
    const offsetSeconds = row * 30;
    const turn = Math.floor(row / 2) + 1;
    items.push(
      row % 2 === 0
        ? tracePromptItem(row, offsetSeconds, `Step ${turn}: keep going.`)
        : traceSayItem(
            row,
            offsetSeconds,
            `Step ${turn} done, moved on to the next file.`,
            { cum: turn * 0.02, costDelta: 0.02 }
          )
    );
  }
  return items;
}

/**
 * ISS-5819 review (wongk): stamp a hand-built strip with the producer bin bounds
 * a real producer emits.
 *
 * The desktop collector and the web synthesizer both state the wall-clock span
 * each bin was binned over, and the clock projection refuses to run on a strip
 * that does not — so a fixture that omits them is modelling a PRE-bounds payload,
 * not a current one. Suites that mean to exercise the projected strip call this;
 * suites that mean to exercise the ordinal fallback deliberately do not.
 */
export function withProducerBinBounds(
  buckets: readonly ActivityBucket[],
  window: { endMs: number; startMs: number }
): ActivityBucket[] {
  // `Math.max(1, …)` on the SPAN, matching both real producers: the desktop
  // collector floors `durationMs` at 1ms and the web synthesizer floors `spanMs`
  // the same way, so neither can emit a zero-width bin even when every event
  // landed on one instant. A fixture that did would be modelling a producer that
  // does not exist, and its bins would contribute nothing.
  const binMs =
    Math.max(1, window.endMs - window.startMs) / Math.max(1, buckets.length);
  return buckets.map((bucket, index) => ({
    ...bucket,
    binEndMs: window.startMs + (index + 1) * binMs,
    binStartMs: window.startMs + index * binMs,
  }));
}
