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
import type { Meta, StoryObj } from "@storybook/react";
import { createRef } from "react";
import { fn } from "storybook/test";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import type { BranchesDataSource } from "../../data-source/branches-data-source";
import { BranchesDataSourceProvider } from "../../data-source/provider";
import { completeMetrics } from "../branch-story-metric-fixtures";
import { BranchSessionsTimelineTab } from "./branch-sessions-timeline-tab";

const LOADING_BRANCH_ID = "timeline-loading";
const PARTIAL_BRANCH_ID = "timeline-partial";
const scrollElementRef = createRef<HTMLDivElement>();

const partialDetail = makeBranchDetail({
  id: PARTIAL_BRANCH_ID,
  branchName: "feature/branches-detail",
  repoFullName: "owner/repo",
  status: BranchStatus.Merged,
  prNumber: 1270,
  prTitle: "Add Branch Detail page",
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
      name: "Implement Branch Details",
      startedAt: "2026-06-17T10:00:00.000Z",
      endedAt: "2026-06-17T11:00:00.000Z",
      estimatedCostUsd: 2.5,
      ownerUserName: "Chris",
    }),
    makeBranchSession({
      sessionId: "s2",
      slug: "SES-2",
      name: "Review Branch Details",
      startedAt: "2026-06-17T11:00:00.000Z",
      endedAt: "2026-06-17T12:00:00.000Z",
      estimatedCostUsd: 1.5,
      ownerUserName: "Daniel",
    }),
  ],
  canonicalMetrics: completeMetrics(),
});

const partialTrace: BranchTraceResult = {
  items: [
    {
      type: "sessionstart",
      sessionId: "s1",
      t: "2026-06-17T10:00:00.000Z",
      actor: { name: "Chris", harness: "codex" },
    },
    {
      type: "prompt",
      sessionId: "s1",
      t: "2026-06-17T10:05:00.000Z",
      tMs: 300_000,
      cumCostUsd: 0.5,
      actorName: "Chris",
      text: "Align the Branch Details screen with the approved prototype.",
    },
    {
      type: "say",
      sessionId: "s1",
      t: "2026-06-17T10:25:00.000Z",
      tMs: 1_500_000,
      cumCostUsd: 2.5,
      actorName: "Codex",
      text: "Implemented the selected-cycle detail panels and responsive layout.",
    },
    { type: "end", sessionId: "s1", text: "Session ended" },
  ],
  sessions: [
    {
      identity: {
        artifactId: "s1",
        name: "Implement Branch Details",
        slug: "SES-1",
        navigableRef: "SES-1",
      },
      state: BranchTraceSessionHydrationState.Loaded,
    },
    {
      identity: {
        artifactId: "s2",
        name: "Review Branch Details",
        slug: "SES-2",
        navigableRef: "SES-2",
      },
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

const timelineSource: BranchesDataSource = {
  scope: "timeline-state-story",
  list: () => Promise.reject(new Error("list unused")),
  detail: () => Promise.reject(new Error("detail unused")),
  comments: () => Promise.reject(new Error("comments unused")),
  trace: (id) =>
    id === LOADING_BRANCH_ID ? pendingTrace() : Promise.resolve(partialTrace),
  usage: () => Promise.reject(new Error("usage unused")),
  analytics: () => Promise.reject(new Error("analytics unused")),
  pageData: () => Promise.reject(new Error("page data unused")),
};

const meta = {
  title: "App Core/Branches/Branch Sessions Timeline Tab",
  component: BranchSessionsTimelineTab,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <BranchesDataSourceProvider dataSource={timelineSource}>
        <div className="h-[640px] w-full overflow-hidden">
          <Story />
        </div>
      </BranchesDataSourceProvider>
    ),
  ],
  argTypes: {
    detail: {
      control: "object",
      description:
        "Branch projection whose `id` selects the trace this tab lazily reads.",
    },
    loc: {
      control: "object",
      description: "Pre-resolved changed-LOC. Null members mean unavailable.",
    },
    onComposerTargetChange: { control: false, table: { category: "Events" } },
    onRenderedSessionsChange: { control: false, table: { category: "Events" } },
    pendingJumpAnchor: { control: "object" },
    queryIdentity: { control: "object" },
    scrollElementRef: {
      control: false,
      description: "Scroll container the timeline virtualizer measures.",
    },
  },
  args: {
    detail: partialDetail,
    onComposerTargetChange: fn(),
    onRenderedSessionsChange: fn(),
    scrollElementRef,
  },
} satisfies Meta<typeof BranchSessionsTimelineTab>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Lazy trace acquisition keeps the timeline geometry stable with one bounded skeleton. */
export const Loading: Story = {
  args: {
    detail: { ...partialDetail, id: LOADING_BRANCH_ID },
  },
};

/** One unavailable Session and truncated events remain explicit beside the loaded trace. */
export const TruncatedPartialSessionCoverage: Story = {};

function pendingTrace(): Promise<BranchTraceResult> {
  return new Promise(() => undefined);
}
