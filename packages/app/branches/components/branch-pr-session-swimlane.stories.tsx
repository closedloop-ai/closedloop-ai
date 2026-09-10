import {
  type BranchPageDetail,
  type BranchSession,
  BranchStatus,
} from "@repo/api/src/types/branch";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { BranchPrSessionSwimlane } from "./branch-pr-session-swimlane";

function session(over: Partial<BranchSession>): BranchSession {
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
    ownerUserName: null,
    ...over,
  };
}

function detail(
  sessions: BranchSession[],
  mergedTrace: MergedTraceItem[]
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
    additions: null,
    deletions: null,
    filesChanged: null,
    estimatedCostUsd: null,
    lastActivityAt: "2026-06-10T12:00:00.000Z",
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

function say(sessionId: string, t: string): MergedTraceItem {
  return {
    type: "say",
    sessionId,
    t,
    tMs: 0,
    cumCostUsd: null,
    actorName: null,
    text: "x",
  };
}

const meta = {
  title: "Composites/Branches/PR Session Swimlane",
  component: BranchPrSessionSwimlane,
  tags: ["autodocs"],
  argTypes: {
    detail: { control: "object", table: { category: "Data" } },
    actorDomain: {
      control: false,
      description:
        "Shared actor color domain; derived internally when omitted.",
      table: { category: "Data" },
    },
    range: {
      control: "object",
      description: "Shared axis so lanes align with the timeline bars.",
      table: { category: "Data" },
    },
    activeTimestamp: {
      control: "text",
      description: "Draws the playhead line across the lanes.",
      table: { category: "State" },
    },
    isLoading: { control: "boolean", table: { category: "State" } },
    onScrubTimestamp: { control: false, table: { category: "Events" } },
    getSessionHref: {
      control: false,
      description: "Omitted keeps the lane label plain text.",
      table: { category: "Events" },
    },
    className: { control: "text", table: { category: "Appearance" } },
  },
  args: {
    isLoading: false,
    onScrubTimestamp: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchPrSessionSwimlane>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleSession: Story = {
  args: {
    detail: detail(
      [session({ sessionId: "s1", harness: "claude" })],
      [
        {
          type: "sessionstart",
          sessionId: "s1",
          t: "2026-06-10T10:00:00.000Z",
          actor: { name: "alice", harness: "claude" },
        },
        say("s1", "2026-06-10T10:00:00.000Z"),
        say("s1", "2026-06-10T10:50:00.000Z"),
      ]
    ),
  },
};

export const MultiSessionWithCiAndResumed: Story = {
  args: {
    detail: detail(
      [
        session({ sessionId: "s1", harness: "claude" }),
        session({
          sessionId: "s2",
          harness: "ci",
          startedAt: "2026-06-10T10:30:00.000Z",
          endedAt: "2026-06-10T10:45:00.000Z",
        }),
      ],
      [
        {
          type: "sessionstart",
          sessionId: "s1",
          t: "2026-06-10T10:00:00.000Z",
          actor: { name: "alice", harness: "claude" },
        },
        say("s1", "2026-06-10T10:00:00.000Z"),
        say("s1", "2026-06-10T10:40:00.000Z"),
        {
          type: "sessionstart",
          sessionId: "s2",
          t: "2026-06-10T10:30:00.000Z",
          actor: { name: null, harness: "ci", ci: true },
        },
        say("s2", "2026-06-10T10:30:00.000Z"),
      ]
    ),
  },
};

export const Empty: Story = {
  args: { detail: detail([], []) },
};
