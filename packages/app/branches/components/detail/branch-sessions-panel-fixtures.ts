// gardener-support: test and story data, not shipped
import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { completeMetrics } from "../branch-story-metric-fixtures";

/**
 * ISS-10793: shared fixtures for the Branch Sessions panel's stories and
 * tests, and for the production tab's own story -- a two-session branch with a
 * complete trace and a partial one (one Session withheld by permission, events
 * truncated). Placeholder people and "Fixture:" copy only.
 */
export const sessionsPanelDetail: BranchPageDetail = makeBranchDetail({
  id: "sessions-panel-branch",
  branchName: "feature/branches-detail",
  repoFullName: "owner/repo",
  status: BranchStatus.Merged,
  prNumber: 1270,
  prTitle: "Fixture: Add Branch Detail page",
  prState: GitHubPRState.Merged,
  prUrl: "https://github.com/owner/repo/pull/1270",
  additions: 180,
  deletions: 24,
  estimatedCostUsd: 4,
  lastActivityAt: "2026-06-17T12:00:00.000Z",
  sessionIds: ["s1", "s2"],
  openedAt: "2026-06-17T11:00:00.000Z",
  closedAt: "2026-06-17T12:00:00.000Z",
  mergedAt: "2026-06-17T12:00:00.000Z",
  sessions: [
    makeBranchSession({
      sessionId: "s1",
      slug: "SES-1",
      name: "Fixture: Implement Branch Details",
      startedAt: "2026-06-17T10:00:00.000Z",
      endedAt: "2026-06-17T11:00:00.000Z",
      estimatedCostUsd: 2.5,
      ownerUserName: "Fixture A",
    }),
    makeBranchSession({
      sessionId: "s2",
      slug: "SES-2",
      name: "Fixture: Review Branch Details",
      startedAt: "2026-06-17T11:00:00.000Z",
      endedAt: "2026-06-17T12:00:00.000Z",
      estimatedCostUsd: 1.5,
      ownerUserName: "Fixture B",
    }),
  ],
  canonicalMetrics: completeMetrics(),
});

const SESSION_ONE_ITEMS: BranchTraceResult["items"] = [
  {
    type: "sessionstart",
    sessionId: "s1",
    t: "2026-06-17T10:00:00.000Z",
    actor: { name: "Fixture A", harness: "codex" },
  },
  {
    type: "prompt",
    sessionId: "s1",
    t: "2026-06-17T10:05:00.000Z",
    tMs: 300_000,
    cumCostUsd: 0.5,
    actorName: "Fixture A",
    text: "Fixture: Align the Branch Details screen with the approved prototype.",
  },
  {
    type: "say",
    sessionId: "s1",
    t: "2026-06-17T10:25:00.000Z",
    tMs: 1_500_000,
    cumCostUsd: 2.5,
    actorName: "Codex",
    text: "Fixture: Implemented the selected-cycle detail panels and responsive layout.",
  },
  { type: "end", sessionId: "s1", text: "Session ended" },
];

const SESSION_TWO_ITEMS: BranchTraceResult["items"] = [
  {
    type: "sessionstart",
    sessionId: "s2",
    t: "2026-06-17T11:00:00.000Z",
    actor: { name: "Fixture B", harness: "claude" },
  },
  {
    type: "prompt",
    sessionId: "s2",
    t: "2026-06-17T11:10:00.000Z",
    tMs: 600_000,
    cumCostUsd: 0.4,
    actorName: "Fixture B",
    text: "Fixture: Review the Branch Details changes before merge.",
  },
  { type: "end", sessionId: "s2", text: "Session ended" },
];

const SESSION_ONE_IDENTITY = {
  artifactId: "s1",
  name: "Fixture: Implement Branch Details",
  slug: "SES-1",
  navigableRef: "SES-1",
};
const SESSION_TWO_IDENTITY = {
  artifactId: "s2",
  name: "Fixture: Review Branch Details",
  slug: "SES-2",
  navigableRef: "SES-2",
};

export const completeSessionsTrace: BranchTraceResult = {
  items: [...SESSION_ONE_ITEMS, ...SESSION_TWO_ITEMS],
  sessions: [
    {
      identity: SESSION_ONE_IDENTITY,
      state: BranchTraceSessionHydrationState.Loaded,
    },
    {
      identity: SESSION_TWO_IDENTITY,
      state: BranchTraceSessionHydrationState.Loaded,
    },
  ],
  qualifyingSessionCount: 2,
  completeness: { state: BranchTraceCompletenessState.Complete },
  aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
};

export const partialSessionsTrace: BranchTraceResult = {
  items: SESSION_ONE_ITEMS,
  sessions: [
    {
      identity: SESSION_ONE_IDENTITY,
      state: BranchTraceSessionHydrationState.Loaded,
    },
    {
      identity: SESSION_TWO_IDENTITY,
      state: BranchTraceSessionHydrationState.Unavailable,
      reason: BranchTraceUnavailableReason.Permission,
    },
  ],
  qualifyingSessionCount: 2,
  completeness: {
    state: BranchTraceCompletenessState.Incomplete,
    reason: BranchTraceUnavailableReason.Permission,
    eventsTruncated: true,
  },
  aggregateCompleteness: {
    state: BranchTraceCompletenessState.Incomplete,
    reason: BranchTraceUnavailableReason.Permission,
  },
};
