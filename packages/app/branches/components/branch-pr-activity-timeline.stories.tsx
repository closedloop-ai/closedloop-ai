import {
  type BranchPageDetail,
  type BranchSession,
  BranchStatus,
  type MergedTraceItem,
} from "@repo/api/src/types/branch";
import type { Meta, StoryObj } from "@storybook/react";
import { BranchPrActivityTimeline } from "./branch-pr-activity-timeline";

function ses(over: Partial<BranchSession>): BranchSession {
  return {
    sessionId: "s1",
    slug: null,
    name: null,
    harness: "claude",
    startedAt: "2026-06-10T10:00:00.000Z",
    endedAt: "2026-06-10T11:00:00.000Z",
    isPrimary: true,
    estimatedCostUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

function startItem(
  sessionId: string,
  t: string,
  name: string | null
): MergedTraceItem {
  return { type: "sessionstart", sessionId, t, actor: { name, harness: null } };
}

function detail(
  sessions: BranchSession[],
  mergedTrace: MergedTraceItem[] = []
): BranchPageDetail {
  return {
    id: "b1",
    branchName: "feature/x",
    baseBranch: "main",
    repoFullName: "acme/web",
    owner: null,
    status: BranchStatus.Open,
    prNumber: 42,
    prTitle: "Add x",
    prState: "OPEN",
    prUrl: null,
    multiPrWarning: false,
    checksStatus: null,
    checksPassed: null,
    checksTotal: null,
    reviewDecision: null,
    ahead: null,
    behind: null,
    additions: 1200,
    deletions: 300,
    filesChanged: null,
    estimatedCostUsd: 42.5,
    lastActivityAt: "2026-06-10T15:00:00.000Z",
    sessionIds: sessions.map((s) => s.sessionId),
    prBody: null,
    prBodyHtmlUrl: null,
    headSha: null,
    mergeCommitSha: null,
    mergedAt: null,
    closedAt: null,
    openedAt: null,
    commits: [],
    sessions,
    mergedTrace,
    leadTime: { firstActivityT: null, lastActivityT: null, idleSpans: [] },
    linkedPrNumbers: [42],
    linkedArtifacts: [],
  };
}

const meta = {
  title: "App Core/Branches/PR Activity Timeline",
  component: BranchPrActivityTimeline,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchPrActivityTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

/** v1 degraded state — one session, one harness actor. */
export const SingleActor: Story = {
  args: {
    detail: detail([
      ses({
        sessionId: "s1",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: "2026-06-10T13:00:00.000Z",
        inputTokens: 2400,
      }),
    ]),
  },
};

/** Two actors, with a concurrency-marked hour. */
export const MultiActorConcurrent: Story = {
  args: {
    detail: detail(
      [
        ses({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          inputTokens: 1600,
        }),
        ses({
          sessionId: "s2",
          startedAt: "2026-06-10T11:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          inputTokens: 800,
        }),
      ],
      [
        startItem("s1", "2026-06-10T10:00:00.000Z", "Kris + Claude"),
        startItem("s2", "2026-06-10T11:00:00.000Z", "Thadeus + Claude"),
      ]
    ),
  },
};

/** A gap hour (no active session) renders as a hatched empty slot. */
export const IdleGap: Story = {
  args: {
    detail: detail([
      ses({
        sessionId: "s1",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: "2026-06-10T11:00:00.000Z",
        inputTokens: 600,
      }),
      ses({
        sessionId: "s2",
        startedAt: "2026-06-10T13:00:00.000Z",
        endedAt: "2026-06-10T14:00:00.000Z",
        inputTokens: 900,
      }),
    ]),
  },
};

export const Empty: Story = {
  args: { detail: detail([]) },
};
