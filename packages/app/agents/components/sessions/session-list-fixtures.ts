import type {
  AgentSessionAnalytics,
  AgentSessionListItem,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";

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
    issueId: null,
    lastActivityAt: new Date("2026-06-01T14:44:00.000Z"),
    model: "gpt-5.5",
    name: "Shared sessions list extraction",
    outputTokens: 12_000,
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
    status: "waiting",
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
    status: "waiting",
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
  viewerScope: AgentSessionAnalytics["viewerScope"] = "organization",
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
