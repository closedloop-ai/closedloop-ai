import type {
  AgentSessionAnalytics,
  AgentSessionListItem,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import {
  AgentSessionViewerScope,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import { CostAvailability } from "@repo/app/agents/lib/cost-availability";
import type { SessionSummaryDeltas } from "@repo/app/agents/lib/session-summary-deltas";
import { MetricPolarity } from "@repo/design-system/components/ui/primitives/metric-polarity";

/**
 * Builds realistic list rows for shared sessions table stories and tests.
 * Overrides intentionally accept unknown values so boundary tests can model
 * migration-window API projections that are temporarily null despite stricter
 * TypeScript DTO fields.
 */
export function createAgentSessionListItemFixture(
  overrides: Partial<Record<keyof AgentSessionListItem, unknown>> &
    Record<string, unknown> = {}
): AgentSessionListItem {
  return {
    agentCount: 2,
    awaitingInputSince: null,
    baseBranch: "main",
    branch: "fea-2036",
    cacheReadTokens: 1200,
    cacheWriteTokens: 400,
    computeTarget: {
      id: "compute-target-1",
      isOnline: true,
      lastAgentSessionSyncAt: new Date("2026-06-01T14:50:00.000Z"),
      lastSeenAt: new Date("2026-06-01T15:00:00.000Z"),
      machineName: "MacBook Pro",
    },
    cwd: "/workspace/symphony-alpha",
    endedAt: new Date("2026-06-01T14:45:00.000Z"),
    errorCount: 0,
    estimatedCost: 4.25,
    externalSessionId: "external-session-1",
    harness: "codex",
    id: "session-1",
    inputTokens: 48_000,
    lastActivityAt: new Date("2026-06-01T14:44:00.000Z"),
    lastSyncedAt: new Date("2026-06-01T14:45:00.000Z"),
    model: "gpt-5.5",
    name: "Shared sessions list extraction",
    outputTokens: 12_000,
    prs: [
      {
        num: 42,
        title: "Add session PR columns",
        status: SessionPrLifecycleStatus.Open,
      },
      {
        num: 43,
        title: "Merge session sync",
        status: SessionPrLifecycleStatus.Merged,
      },
    ],
    prsMerged: 1,
    project: null,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    sourceArtifact: {
      documentType: DocumentType.Feature,
      id: "artifact-1",
      name: "Desktop MLP",
      slug: "FEA-1515",
    },
    sourceArtifactId: "artifact-1",
    sourceLoopId: "loop-1",
    startedAt: new Date("2026-06-01T13:30:00.000Z"),
    // DELIBERATELY the retired `completed` spelling, bound to its constant
    // rather than restated: `status` is a free-form column, and this default
    // models the version-skewed producer every consumer of this fixture has to
    // survive. ISS-5592 retired the alias for real — the binding that used to
    // live here did its job and broke `tsc` — so this is now a plain literal
    // standing for any spelling the fold does not recognize, which is exactly
    // what a straggler `completed` is.
    status: "completed",
    toolUseCount: 14,
    updatedAt: new Date("2026-06-01T14:44:00.000Z"),
    user: {
      avatarUrl: null,
      email: "daniel.ochoa@closedloop.ai",
      firstName: "Daniel",
      id: "user-1",
      lastName: "Ochoa",
    },
    worktreePath: "/workspace/symphony-alpha-fea-1515",
    ...overrides,
  } as AgentSessionListItem;
}

export const populatedAgentSessionListFixtures: AgentSessionListItem[] = [
  createAgentSessionListItemFixture(),
  createAgentSessionListItemFixture({
    awaitingInputSince: new Date("2026-06-02T10:00:00.000Z"),
    cwd: null,
    endedAt: null,
    externalSessionId: "external-waiting-session",
    id: "session-2",
    model: "claude-opus-4.1",
    name: null,
    repositoryFullName: "closedloop-ai/desktop",
    startedAt: new Date("2026-06-02T09:00:00.000Z"),
    status: DISPLAYED_SESSION_STATUS.WAITING,
    updatedAt: new Date("2026-06-02T10:05:00.000Z"),
    worktreePath: "/workspace/closedloop-electron",
  }),
];

export const mixedAgentSessionListFixtures: AgentSessionListItem[] = [
  createAgentSessionListItemFixture({
    id: "session-name",
    name: "Named Session",
  }),
  createAgentSessionListItemFixture({
    awaitingInputSince: new Date("2026-06-03T12:00:00.000Z"),
    cwd: null,
    externalSessionId: "external-name-fallback",
    branch: null,
    id: "session-external",
    model: null,
    name: null,
    status: DISPLAYED_SESSION_STATUS.WAITING,
  }),
  createAgentSessionListItemFixture({
    cwd: null,
    id: "session-worktree",
    name: "Worktree fallback",
    repositoryFullName: "closedloop-ai/repo-fallback",
    worktreePath: "/worktrees/shared-list",
  }),
  createAgentSessionListItemFixture({
    cacheReadTokens: null,
    cacheWriteTokens: null,
    branch: "",
    cwd: null,
    endedAt: null,
    estimatedCost: null,
    id: "session-unknown",
    inputTokens: null,
    name: "Unknown location row",
    outputTokens: null,
    repositoryFullName: null,
    startedAt: null,
    updatedAt: null,
    worktreePath: null,
  }),
  // FEA-4274: the defect state — a session with real Git evidence (a populated
  // branch chip + an Open PR) whose remote has not resolved, running out of a
  // numbered worktree dir. The Repository column must NOT read the folder name
  // (`3`) as "Repository 3"; it renders "Unknown" next to the branch and PR.
  createAgentSessionListItemFixture({
    id: "session-unresolved-remote",
    name: "Unresolved remote, numbered worktree",
    repositoryFullName: null,
    branch: "mike/nightly-review",
    prs: [
      {
        num: 33,
        title: "Nightly review crew worker",
        status: SessionPrLifecycleStatus.Open,
      },
    ],
    prsMerged: 0,
    cwd: "/Users/chris.chenault/Code/3",
    worktreePath: "/Users/chris.chenault/Code/3",
  }),
];

/**
 * Builds the usage aggregate shape expected by monitoring page wrappers.
 */
export function createAgentSessionUsageSummaryFixture(
  viewerScope: AgentSessionUsageSummary["viewerScope"],
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    latestSessionAt: null,
    lastSyncTargets: [],
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions: 1,
    viewerScope,
    ...overrides,
  };
}

/**
 * Builds analytics breakdowns for shared monitoring stories and tests.
 */
export function createAgentSessionAnalyticsFixture(
  viewerScope: AgentSessionAnalytics["viewerScope"] = AgentSessionViewerScope.Organization,
  overrides: Partial<AgentSessionAnalytics> = {}
): AgentSessionAnalytics {
  return {
    byAgentType: [
      {
        agentType: "coder",
        avgDurationMs: 120_000,
        count: 3,
        failedCount: 0,
        successCount: 3,
      },
    ],
    byProject: [
      {
        estimatedCost: 3.25,
        inputTokens: 1200,
        outputTokens: 800,
        projectId: "project-1",
        projectName: "Platform",
        projectSlug: "platform",
        sessionCount: 2,
      },
    ],
    byRepository: [
      {
        errorCount: 0,
        estimatedCost: 3.25,
        inputTokens: 1200,
        outputTokens: 800,
        repositoryFullName: "closedloop-ai/symphony-alpha",
        sessionCount: 2,
      },
    ],
    byTool: [
      {
        errorCount: 0,
        invocationCount: 4,
        sessionCount: 2,
        toolName: "apply_patch",
      },
    ],
    viewerScope,
    ...overrides,
  };
}

/**
 * Builds a display-ready {@link SessionTableRow} for shared Sessions-table
 * stories and tests.
 *
 * ISS-5697: `SessionTableRow` was hand-rolled in seven places — the table story
 * plus six suites — each re-spelling the type's required fields, so a new column
 * landed in whichever copies its author happened to open. This is the one
 * definition.
 *
 * The default is deliberately a NEUTRAL row, not a rich realistic one: it fills
 * the REQUIRED fields (including the `pullRequests` / `pullRequestSummaryLabel`
 * / `mergeStatusLabel` trio that every caller was repeating) and leaves every
 * OPTIONAL field — `user`, `repo`, `branch`, `model`, `autonomy`,
 * `repositoryDisplay`, `costTooltip` — undefined. A populated default would be
 * worse than the literals it replaces: callers here are a permutation table of
 * deliberately different rows, so a rich base means most of them override it
 * anyway AND the ones that don't silently inherit an identity (an owner, a repo,
 * an open PR) that has nothing to do with the case under test.
 *
 * Deliberately NOT derived by running `agentSessionToSessionTableRow` over an
 * `AgentSessionListItem` fixture, even though that mapper is the production
 * path: it resolves `startedLabel`/`lastActivityLabel` through
 * `formatRelativeTime` against the ambient clock, so a snapshot story built that
 * way drifts ("2h ago" → "3 months ago") with no code change. `SyncedSessionsTable`
 * exercises that mapper on the DTO fixtures; this covers the presentational
 * contract, which is display-ready strings.
 */
export function createSessionTableRowFixture(
  overrides: Partial<SessionTableRow> = {}
): SessionTableRow {
  return {
    costAvailability: CostAvailability.Available,
    costLabel: "$4.12",
    durationLabel: "12m",
    harness: "claude",
    id: "ses-1",
    lastActivityLabel: "5m ago",
    mergeStatusLabel: null,
    name: "agent/refactor-auth-guard",
    pullRequestSummaryLabel: null,
    pullRequests: [],
    startedLabel: "2h ago",
    status: SESSION_STATUS.ACTIVE,
    ...overrides,
  };
}

/**
 * ISS-5842: a movement for EVERY card in the Sessions strip that can carry one,
 * on the production polarities `buildSessionSummaryDeltas` assigns — Sessions
 * and PRs Shipped are `HigherIsBetter`, both cost bases are `LowerIsBetter`, and
 * token VOLUME is deliberately `Neutral` (it is the substance of spend, so
 * calling a rise "better" would contradict the Cost card beside it).
 *
 * ## Why every tone here grades out NEUTRAL
 *
 * Neutral is the only tone where the two `MetricDeltaTreatment` families differ
 * visibly: `Legacy` renders a neutral delta BARE, `UnifiedPill` gives it the full
 * pill plus `bg-foreground/5`. A scored tone gets identical geometry AND colour
 * under both, so a card stuck on the `Legacy` default still looks correct — which
 * is exactly how the Sessions and Total Tokens cards shipped on the wrong
 * treatment unnoticed. A fixture whose cards were scored could not observe the
 * defect it exists to pin. `-52` is the operator-reported figure from the
 * screenshots that opened the ticket; a `0` on a scored-polarity metric is the
 * other route to the same neutral sentiment.
 *
 * ## Why the whole strip and not just the two broken cards
 *
 * A "whole strip" assertion built on a Sessions+Tokens-only object can only ever
 * observe the two cards already covered card-by-card, so it would pass without
 * saying anything about Cost or the delivery pair (wongk, #4907). `apiCost` and
 * `meteredCost` are BOTH populated because `costDeltaKey` picks the basis the
 * headline actually resolved to, and `deliveryCompared` is set because the
 * delivery pair's participation is opt-in and its absence yields no chip at all.
 *
 * Shared rather than hand-built at each call site (per `agents/AGENTS.md`) so the
 * delta-treatment story and its test cannot drift onto different fixtures and
 * stop describing the same render.
 */
export function createSessionSummaryDeltasFixture(
  overrides: Partial<SessionSummaryDeltas> = {}
): SessionSummaryDeltas {
  return {
    apiCost: { delta: 0, deltaPolarity: MetricPolarity.LowerIsBetter },
    deliveryCompared: true,
    label: "vs. prior 30 days",
    meteredCost: { delta: 0, deltaPolarity: MetricPolarity.LowerIsBetter },
    prsShipped: { delta: 0, deltaPolarity: MetricPolarity.HigherIsBetter },
    sessions: { delta: 0, deltaPolarity: MetricPolarity.HigherIsBetter },
    tokens: { delta: -52, deltaPolarity: MetricPolarity.Neutral },
    ...overrides,
  };
}

/**
 * ISS-5842: a usage read on which every card in the strip renders a real value,
 * so none of them drops its delta slot for want of a headline to grade.
 *
 * The delta cards each have their own honesty gate — the Cost tile dashes and
 * drops its chip when it cannot state a figure (ISS-5401), and the delivery pair
 * carries a chip only on its available branch — so a fixture with zero cost and
 * a null merged-PR count would silently reduce a whole-strip assertion to the two
 * always-available cards again.
 */
export function createFullyPopulatedSessionsUsageFixture(): AgentSessionUsageSummary {
  return createAgentSessionUsageSummaryFixture(
    AgentSessionViewerScope.Organization,
    {
      apiEstimatedCost: 412,
      mergedLocPerDollar: 3.5,
      mergedPrCount: 7,
      totalEstimatedCost: 412,
      totalInputTokens: 900,
      totalOutputTokens: 100,
      totalSessions: 12,
    }
  );
}
