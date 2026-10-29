/**
 * Session-detail e2e fixtures.
 *
 * The `AgentSessionDetail` payload `session-detail.spec.ts` serves from its
 * mocked backend route, plus the dense timeline-marker set that payload builds.
 * Lifted out of the spec (ISS-4674) so the spec stays under the repo file-size
 * ceiling, and so any future session-detail spec serves the SAME session rather
 * than forking a near-copy that silently drifts from this one.
 *
 * Deliberately NOT built on `createAgentSessionDetailFixture`
 * (`packages/app/agents/components/detail/agent-session-detail-fixtures.ts`),
 * the canonical builder the @repo/app unit suite uses. That builder is
 * importable from here — `visual-fixtures.ts` reaches package source the same
 * way — but this session shares almost none of its values: a different id /
 * slug / external id, and its own agents, actors, events, markers, throttles,
 * and timeline, all of which the spec asserts on directly. Backing it with the
 * unit builder would mean overriding nearly every field (no real reduction) and
 * would couple the required `e2e` check to a fixture the unit suite owns and is
 * free to retune — a unit-side edit would then break e2e assertions with no
 * signal at the edit site. So the two fixtures stay independent on purpose.
 */

// ISS-4791: BOTH shared imports resolve through the ROOT tsconfig `paths`, which
// is what makes them safe here. A module reached from inside `packages/lib`
// resolves against `packages/lib/tsconfig.json` instead, which declares no
// `paths` — so its own extensionless `@repo/api/src/...` imports fall back to
// Node resolution and the whole Playwright run dies at config load. Keep this
// suite's shared imports on zero-dependency `@repo/api` modules.
import { DECLARED_EVIDENCE_LAYER } from "@repo/api/src/activity-evidence-layers";
import {
  type AgentSessionDetail,
  AgentSessionOrigin,
  SessionTracePhaseSourceType,
  type SyncedActivitySegmentRow,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import { currentUser as baseCurrentUser } from "./mock-users";

export const SESSION_ID = "019ecbbf-691a-76ca-ba72-aa554ed9b151";
// The long human-steering marker label, asserted by the spec's timeline-tooltip
// case — it must wrap rather than clip, so its length is load-bearing.
export const DENSE_MARKER_LABEL =
  "Human steering checkpoint with enough text to verify the timeline tooltip wraps readable content instead of clipping the event label.";
const BASE_TIME = "2026-06-10T12:00:00.000Z";
const STACK_COMMIT_LABEL = "Commit and PR checkpoint";
const STACK_FAILURE_LABEL = "Failure and limit checkpoint";
/**
 * ISS-4791. The session's end, and the boundaries of the raw activity tiling
 * below. The tiling covers the session window EXACTLY (`BASE_TIME` →
 * `SESSION_END_TIME`), so the "Activity phases" strip — which runs on its own
 * min/max, not the session-duration scale — spans the same elapsed time as the
 * "Session Timeline" axis directly above it. That is what makes the two
 * vertically-adjacent captions comparable as strings, which is the only place
 * the reported inconsistency was ever visible.
 */
const SESSION_END_TIME = "2026-06-10T12:20:00.000Z";
const IMPLEMENT_END_TIME = "2026-06-10T12:15:00.000Z";
const VALIDATE_END_TIME = "2026-06-10T12:18:00.000Z";
/**
 * ISS-4791: the one duration string BOTH adjacent time captions must render —
 * the axis total ("Session Timeline") and the "phases span …" caption. It is
 * `formatDuration`'s shared `Mm Ss` unit system over the 20-minute window above,
 * NOT the bare rounded-up minute total ("20m") the axis used to print. Exported
 * so the spec asserts against one value rather than repeating the literal.
 *
 * The axis end resolves to `endedAt`: the plotted-activity window covers the
 * phase tiling's own span, which the idle tail below closes out to `endedAt`.
 *
 * ISS-5137: that was NOT true between ISS-4833 and ISS-5137. The reconciled
 * window excluded IDLE segments, so it ended at the last attributed work
 * (`VALIDATE_END_TIME`, 12:18) and this assertion failed with "expected calendar
 * span 20m 0s, received 18m 0s" — a real contract break, since the "phases span"
 * caption one row below kept printing the full 20m.
 */
export const SESSION_DURATION_CAPTION = "20m 0s";

export function sessionDetailFixture(): AgentSessionDetail {
  const agentActor = {
    color: "var(--primary)",
    harness: "codex",
    human: null,
    name: "gpt-5.5",
    sessionId: SESSION_ID,
  };
  const humanActor = {
    color: "hsl(210 65% 45%)",
    human: "Ada Lovelace",
    name: null,
    sessionId: SESSION_ID,
  };

  return {
    activeAgent: "18m",
    activityBuckets: [],
    // ISS-4674: a priced per-phase breakdown so the Activity breakdown table
    // renders real phase rows (not the single unclassified fallback) for the
    // narrow-viewport case below. Costs sum to `estimatedCost` and the token
    // counts sum to the session's own totals, so the panel reconciles.
    activitySegments: [
      {
        cacheReadTokens: 700,
        cacheWriteTokens: 300,
        confidence: 0.82,
        costUsd: 3.2,
        durationMs: 900_000,
        inputTokens: 9000,
        key: "implement",
        label: "Implement",
        outputTokens: 2400,
        source: SessionTracePhaseSourceType.Explicit,
      },
      {
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        confidence: 0.61,
        costUsd: 1.62,
        durationMs: 180_000,
        inputTokens: 3000,
        key: "validate",
        label: "Validate",
        outputTokens: 800,
        source: SessionTracePhaseSourceType.LoopPerf,
      },
      {
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        confidence: null,
        costUsd: 0,
        durationMs: 120_000,
        inputTokens: 0,
        key: "idle",
        label: "Idle",
        outputTokens: 0,
        source: null,
      },
    ],
    // ISS-4791: the RAW activity tiling (the `activitySegmentRows` wire field,
    // FEA-3568) the "Activity phases" strip positions and captions. Without it
    // the strip renders nothing, so the web adapter never exercised the second
    // of the two adjacent duration captions this session's detail must keep in
    // one format. Mirrors the derived `activitySegments` breakdown above.
    activitySegmentRows: activitySegmentTiling(),
    agentCount: 3,
    agents: [
      {
        currentTool: null,
        endedAt: "2026-06-10T12:20:00.000Z",
        externalAgentId: "agent-main",
        name: "Implementation worker",
        parentExternalAgentId: null,
        startedAt: BASE_TIME,
        status: "completed",
        task: "Extract the shared detail foundation.",
        type: "main",
        updatedAt: "2026-06-10T12:18:00.000Z",
      },
      {
        currentTool: null,
        endedAt: "2026-06-10T12:12:00.000Z",
        externalAgentId: "agent-review",
        name: "Review lane",
        parentExternalAgentId: "agent-main",
        startedAt: "2026-06-10T12:04:00.000Z",
        status: "failed",
        subagentType: "review",
        task: "Verify import ownership and state coverage.",
        type: "subagent",
        updatedAt: "2026-06-10T12:12:00.000Z",
      },
    ],
    attribution: {
      baseBranch: "main",
      repositoryFullName: "closedloop-ai/closedloop-ai",
      sourceArtifactId: "FEA-1768",
      sourceLoopId: "loop-session-detail-e2e",
      worktreePath: "worktrees/closedloop-ai-fea-1768-1769-1770",
    },
    autonomy: 82,
    awaitingInputSince: null,
    baseBranch: "main",
    branch: "fea-1768-1769-1770",
    cache: 900,
    cacheReadTokens: 900,
    cacheWrite: 400,
    cacheWriteTokens: 400,
    computeTarget: {
      id: "target-session-detail-e2e",
      isOnline: true,
      lastSeenAt: new Date("2026-06-10T12:21:00.000Z"),
      machineName: "Ada's MacBook",
    },
    cost: "$4.82",
    cwd: "repos/closedloop-ai",
    // ISS-4791: the session end is the axis end, and the tiling above closes on
    // the same instant — one window, one duration, so the two adjacent captions
    // are directly comparable. ISS-5623 added the required `lastActivityAt`
    // below; it is pinned to this SAME instant deliberately, because the axis
    // end is `max(endedAt, lastActivityAt)` and a later value would move the
    // axis and break exactly the comparability this fixture exists to prove.
    endedAt: new Date(SESSION_END_TIME),
    errorCount: 1,
    estimatedCost: 4.82,
    events: [
      {
        agentExternalId: "agent-main",
        createdAt: BASE_TIME,
        eventType: "session_started",
        externalEventId: "event-1",
        summary: "Implementation started.",
      },
      {
        agentExternalId: "agent-main",
        createdAt: "2026-06-10T12:02:00.000Z",
        data: { pattern: "AgentSessionDetailView" },
        eventType: "tool_use",
        externalEventId: "event-2",
        summary: "Inspected current detail callers.",
        toolName: "rg",
      },
      {
        agentExternalId: "agent-review",
        createdAt: "2026-06-10T12:12:00.000Z",
        data: {
          file: "packages/app/agents/components/detail/example.tsx",
        },
        eventType: "error",
        externalEventId: "event-3",
        summary: "Review lane found an import ownership issue.",
        toolName: "vitest",
      },
    ],
    externalSessionId: SESSION_ID,
    filesChanged: 4,
    harness: "codex",
    id: SESSION_ID,
    inputTokens: 12_000,
    lastActivityAt: new Date(SESSION_END_TIME),
    linesAdded: 120,
    linesRemoved: 12,
    markers: denseTimelineMarkers(),
    metadata: {
      branch: "fea-1768-1769-1770",
      validation: "rendered-screen",
    },
    model: "gpt-5.5",
    models: ["gpt-5.5"],
    name: "Desktop implementation session",
    origin: AgentSessionOrigin.DesktopSync,
    outputTokens: 3200,
    phaseIterations: {},
    phaseLoopbacks: [],
    phases: [],
    primaryModel: "gpt-5.5",
    project: {
      id: "project-session-detail-e2e",
      name: "Desktop MLP",
      slug: "PRO-E2E",
    },
    prs: [],
    prsMerged: 0,
    repo: "closedloop-ai/closedloop-ai",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    slug: "SES-E2E",
    sourceArtifact: {
      documentType: null,
      id: "artifact-session-detail-e2e",
      name: "Session Trace Details",
      slug: "FEA-1768",
    },
    sourceArtifactId: "FEA-1768",
    sourceLoopId: "loop-session-detail-e2e",
    span: null,
    startedAt: new Date(BASE_TIME),
    // ISS-5592: `completed` is an unrecognized STORED status now and badges
    // "Active". `inactive` is the recognized terminal value this fixture means.
    status: SESSION_STATUS.INACTIVE,
    steeringEpisodes: 1,
    throttles: [
      {
        durMin: 5,
        t0: "2026-06-10T12:10:00.000Z",
        t1: "2026-06-10T12:15:00.000Z",
        tl: 0,
        x0: 75,
      },
    ],
    tokenUsageByModel: [
      {
        cacheReadTokens: 900,
        cacheWriteTokens: 400,
        estimatedCostUsd: 4.82,
        inputTokens: 12_000,
        model: "gpt-5.5",
        outputTokens: 3200,
      },
    ],
    tokensIn: 12_000,
    tokensOut: 3200,
    toolCallsTotal: 5,
    toolUseCount: 5,
    turnItems: [
      {
        _row: 0,
        actor: humanActor,
        cum: 0,
        t: "2026-06-10T12:01:00.000Z",
        tMs: Date.parse("2026-06-10T12:01:00.000Z"),
        text: "Please inspect the shared session detail screen.",
        type: "prompt",
      },
      {
        _row: 1,
        actor: agentActor,
        cum: 0.5,
        t: "2026-06-10T12:01:30.000Z",
        tMs: Date.parse("2026-06-10T12:01:30.000Z"),
        text: "I will replace the details dashboard with a Session Trace workspace.",
        type: "say",
      },
      {
        _row: 2,
        actor: agentActor,
        cats: { tool: 2 },
        cum: 1.14,
        defaultOpen: true,
        endMs: Date.parse("2026-06-10T12:03:00.000Z"),
        failN: 1,
        hasFail: true,
        items: [
          { detail: "AgentSessionDetailView", err: false, label: "rg" },
          { detail: "detail view coverage", err: true, label: "vitest" },
        ],
        summary: "Ran 2 tools",
        t: "2026-06-10T12:02:00.000Z",
        tMs: Date.parse("2026-06-10T12:02:00.000Z"),
        type: "tools",
      },
      {
        _row: 3,
        dot: "g",
        t: "2026-06-10T12:03:30.000Z",
        tMs: Date.parse("2026-06-10T12:03:30.000Z"),
        tag: "checkpoint",
        text: "Initial implementation checkpoint after #2.",
        type: "event",
      },
      {
        _row: 4,
        actor: agentActor,
        body: [
          {
            kind: "task",
            text: "Verify import ownership and state coverage.",
          },
          {
            err: true,
            kind: "tool",
            t: "2026-06-10T12:12:00.000Z",
            text: "vitest",
          },
          {
            err: true,
            kind: "status",
            t: "2026-06-10T12:12:00.000Z",
            text: "failed",
          },
        ],
        cost: null,
        cum: 2.25,
        duration: "8m",
        model: "gpt-5.5",
        status: "failed",
        sub: "Review lane",
        subagentType: "review",
        t: "2026-06-10T12:04:00.000Z",
        tMs: Date.parse("2026-06-10T12:04:00.000Z"),
        tokens: null,
        type: "subagent",
      },
      {
        text: "Session completed.",
        type: "end",
      },
    ],
    turns: 8,
    updatedAt: new Date("2026-06-10T12:18:00.000Z"),
    user: {
      avatarUrl: null,
      email: "ada@example.com",
      firstName: "Ada",
      id: "user-session-owner-e2e",
      lastName: "Lovelace",
    },
    userColor: "hsl(210 65% 45%)",
    waitingUser: null,
    wallClock: "20m",
    worktreePath: "worktrees/closedloop-ai-fea-1768-1769-1770",
  };
}

/**
 * A contiguous phase tiling covering the whole session window, mirroring the
 * derived `activitySegments` breakdown (implement → validate → idle) so the raw
 * strip and the priced table tell the same story.
 *
 * Mostly non-idle on purpose: FEA-4238 folds a majority-idle strip closed by
 * default, which would hide the "phases span …" caption the spec reads.
 */
function activitySegmentTiling(): SyncedActivitySegmentRow[] {
  return [
    {
      phase: "implement",
      startMs: Date.parse(BASE_TIME),
      endMs: Date.parse(IMPLEMENT_END_TIME),
      confidence: 0.82,
      evidenceLayers: [DECLARED_EVIDENCE_LAYER],
      version: 1,
    },
    {
      phase: "validate",
      startMs: Date.parse(IMPLEMENT_END_TIME),
      endMs: Date.parse(VALIDATE_END_TIME),
      confidence: 0.61,
      evidenceLayers: ["structural"],
      version: 1,
    },
    {
      phase: "idle",
      startMs: Date.parse(VALIDATE_END_TIME),
      endMs: Date.parse(SESSION_END_TIME),
      confidence: 1,
      evidenceLayers: [],
      version: 1,
    },
  ];
}

function denseTimelineMarkers(): NonNullable<AgentSessionDetail["markers"]> {
  const markerX = 50;
  const markers: NonNullable<AgentSessionDetail["markers"]> = [
    {
      kind: "commit",
      label: STACK_COMMIT_LABEL,
      t: "12:01:30 PM",
      tl: 1,
      x: markerX,
    },
    {
      kind: "fail",
      label: STACK_FAILURE_LABEL,
      t: "12:01:45 PM",
      tl: 2,
      x: markerX,
    },
  ];
  for (let index = 0; index < 6; index += 1) {
    markers.push({
      kind: "prompt",
      label: index === 0 ? DENSE_MARKER_LABEL : `Dense steering event ${index}`,
      t: `12:0${index + 1}:00 PM`,
      tl: index,
      x: markerX,
    });
  }
  return markers;
}

// The session-detail specs' signed-in identity for the `/me` shell read.
// Delegates to the canonical `currentUser` in `mock-users.ts` and overrides only
// the fields this suite varies, rather than re-declaring the whole User shape
// (which would drift the moment a field is added to it).
export function currentUser() {
  return baseCurrentUser({
    clerkId: "clerk-session-detail-e2e-user",
    email: "session-detail-e2e@example.com",
    firstName: "Session",
    id: "user-session-detail-e2e",
    organizationId: "org-session-detail-e2e",
  });
}
