import {
  type BranchPageDetail,
  type BranchSession,
  BranchStatus,
} from "@repo/api/src/types/branch";
import type { MergedTraceItem } from "@repo/api/src/types/branch-trace";
import {
  BranchTraceCompletenessState,
  BranchTraceSessionHydrationState,
  type BranchTraceState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
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
    ownerUserName: null,
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
  mergedTrace: MergedTraceItem[] = [],
  estimatedCostUsd = 42.5
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
    estimatedCostUsd,
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
  title: "Composites/Branches/PR Activity Timeline",
  component: BranchPrActivityTimeline,
  tags: ["autodocs"],
  argTypes: {
    detail: { control: "object", table: { category: "Data" } },
    traceState: {
      control: "object",
      description: "Per-session hydration evidence behind the coverage notes.",
      table: { category: "Data" },
    },
    loc: {
      control: "object",
      description: "Branch changed-LOC resolved once at the page boundary.",
      table: { category: "Data" },
    },
    actorDomain: {
      control: false,
      description:
        "Shared actor color domain; derived internally when omitted.",
      table: { category: "Data" },
    },
    isLoading: { control: "boolean", table: { category: "State" } },
    activeHourStart: {
      control: "text",
      description: "Hour bucket the shared playhead currently sits in.",
      table: { category: "State" },
    },
    activeFraction: {
      control: { type: "number", min: 0, max: 1, step: 0.01 },
      description: "Playhead position within the active hour.",
      table: { category: "State" },
    },
    onScrubHour: { control: false, table: { category: "Events" } },
    children: { control: false, table: { category: "Content" } },
    className: { control: "text", table: { category: "Appearance" } },
  },
  args: {
    isLoading: false,
    onScrubHour: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof BranchPrActivityTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One user's spend across a single session (FEA-3576 — segment by user cost). */
export const SingleUser: Story = {
  args: {
    detail: detail([
      ses({
        sessionId: "s1",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: "2026-06-10T13:00:00.000Z",
        inputTokens: 2400,
        estimatedCostUsd: 18,
        ownerUserName: "Chris",
      }),
    ]),
  },
};

/** Two users spending in the same hour, with a concurrency-marked hour. */
export const MultiUserConcurrent: Story = {
  args: {
    detail: detail(
      [
        ses({
          sessionId: "s1",
          startedAt: "2026-06-10T10:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          inputTokens: 1600,
          estimatedCostUsd: 12,
          ownerUserName: "Chris",
        }),
        ses({
          sessionId: "s2",
          startedAt: "2026-06-10T11:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          inputTokens: 800,
          estimatedCostUsd: 6,
          ownerUserName: "Thadeus",
        }),
      ],
      [
        startItem("s1", "2026-06-10T10:00:00.000Z", "Kris + Claude"),
        startItem("s2", "2026-06-10T11:00:00.000Z", "Thadeus + Claude"),
      ]
    ),
  },
};

/** One loaded Session has cost but no measurable timing, so only chartable spend renders. */
export const MixedTimingCompleteness: Story = {
  args: {
    detail: detail(
      [
        ses({
          sessionId: "s1",
          slug: "SES-1",
          estimatedCostUsd: 5,
          ownerUserName: "Chris",
        }),
        ses({
          sessionId: "s2",
          slug: "SES-2",
          startedAt: "2026-06-10T12:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 7,
          ownerUserName: "Thadeus",
        }),
      ],
      [],
      12
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
        estimatedCostUsd: 4,
        ownerUserName: "Chris",
      }),
      ses({
        sessionId: "s2",
        startedAt: "2026-06-10T13:00:00.000Z",
        endedAt: "2026-06-10T14:00:00.000Z",
        inputTokens: 900,
        estimatedCostUsd: 7,
        ownerUserName: "Thadeus",
      }),
    ]),
  },
};

export const Empty: Story = {
  args: { detail: detail([]) },
};

export const PartialCoverage: Story = {
  args: {
    detail: detail([
      ses({ sessionId: "s1", ownerUserName: "Chris" }),
      ses({ sessionId: "s2", ownerUserName: "Thadeus" }),
    ]),
    traceState: traceState(BranchTraceCompletenessState.Incomplete),
  },
};

export const UnavailableCoverage: Story = {
  args: {
    detail: detail([ses({ sessionId: "s1", ownerUserName: "Chris" })]),
    traceState: traceState(BranchTraceCompletenessState.Unavailable),
  },
};

function traceState(
  aggregateState: BranchTraceCompletenessState
): BranchTraceState {
  const incomplete = aggregateState === BranchTraceCompletenessState.Incomplete;
  return {
    aggregateCompleteness: { state: aggregateState },
    completeness: { state: aggregateState },
    qualifyingSessionCount: incomplete ? 2 : 1,
    sessions: [
      ...(incomplete
        ? [
            {
              identity: {
                artifactId: "s1",
                name: "Implementation Session",
                navigableRef: "SES-1",
                slug: "SES-1",
              },
              state: BranchTraceSessionHydrationState.Loaded,
            } as const,
          ]
        : []),
      {
        identity: {
          artifactId: incomplete ? "s2" : "s1",
          name: "Review Session",
          navigableRef: incomplete ? "SES-2" : "SES-1",
          slug: incomplete ? "SES-2" : "SES-1",
        },
        reason: BranchTraceUnavailableReason.Permission,
        state: BranchTraceSessionHydrationState.Unavailable,
      },
    ],
  };
}
