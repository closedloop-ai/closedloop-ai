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
import { TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY } from "@repo/api/src/types/timeline-scale-visible-label-flag";
import { TimelineScale } from "@repo/app/agents/lib/session-timeline-scale";
import type { Meta, StoryObj } from "@storybook/react";
import { type ComponentProps, useState } from "react";
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
  title: "Composites v1.0/Branches/Branch PR Activity Timeline",
  component: BranchPrActivityTimeline,
  tags: ["deprecated", "autodocs"],
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
        ownerUserName: "Cosimo",
      }),
    ]),
  },
};

/**
 * ISS-10599: no prior story here ever passed `onScaleChange`, so the scale
 * toggle — the same `TimelineScaleControl` the Session Timeline uses, same
 * fix — had zero Storybook coverage on this consumer. Rendered LIVE with real
 * `useState`, not a static prop, so the toggle is actually operable here: a
 * control nobody can click in Storybook is a control nobody can check the
 * label, the focus ring, or the keyboard path on.
 *
 * Takes the story's own `args` rather than building a second fixture of its own
 * (#7592 review, marisolashgrove): a `render` that ignores `args` leaves the
 * controls panel editing nothing while the same detail is constructed twice.
 * Dropping the `args` block outright is not the alternative — `detail` is a
 * required prop, so `StoryObj` rejects a story without it.
 *
 * The story turns the visible-label flag ON through the global preview
 * decorator's `appCore` parameter (`apps/storybook/.storybook/preview.tsx`,
 * which passes `parameters.appCore.enabledFlags` into the mounted
 * `FeatureFlagAdapterProvider`). Without it this renders the CLOSED default —
 * the pre-fix unlabeled row — and the one thing the story exists to show is the
 * one thing it could not show.
 */
function LiveScaleControl(
  props: Omit<
    ComponentProps<typeof BranchPrActivityTimeline>,
    "onScaleChange" | "scale"
  >
) {
  const [scale, setScale] = useState<TimelineScale>(TimelineScale.OneHour);

  return (
    <BranchPrActivityTimeline
      {...props}
      onScaleChange={setScale}
      scale={scale}
    />
  );
}

export const WithScaleControl: Story = {
  parameters: {
    appCore: { enabledFlags: [TIMELINE_SCALE_VISIBLE_LABEL_FLAG_KEY] },
  },
  args: {
    detail: detail([
      ses({
        sessionId: "s1",
        startedAt: "2026-06-10T10:00:00.000Z",
        endedAt: "2026-06-10T13:00:00.000Z",
        inputTokens: 2400,
        estimatedCostUsd: 18,
        ownerUserName: "Cosimo",
      }),
    ]),
  },
  render: (args) => <LiveScaleControl {...args} />,
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
          ownerUserName: "Cosimo",
        }),
        ses({
          sessionId: "s2",
          startedAt: "2026-06-10T11:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          inputTokens: 800,
          estimatedCostUsd: 6,
          ownerUserName: "Tamsin",
        }),
      ],
      [
        startItem("s1", "2026-06-10T10:00:00.000Z", "Kerensa + Claude"),
        startItem("s2", "2026-06-10T11:00:00.000Z", "Tamsin + Claude"),
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
          ownerUserName: "Cosimo",
        }),
        ses({
          sessionId: "s2",
          slug: "SES-2",
          startedAt: "2026-06-10T12:00:00.000Z",
          endedAt: "2026-06-10T12:00:00.000Z",
          estimatedCostUsd: 7,
          ownerUserName: "Tamsin",
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
        ownerUserName: "Cosimo",
      }),
      ses({
        sessionId: "s2",
        startedAt: "2026-06-10T13:00:00.000Z",
        endedAt: "2026-06-10T14:00:00.000Z",
        inputTokens: 900,
        estimatedCostUsd: 7,
        ownerUserName: "Tamsin",
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
      ses({ sessionId: "s1", ownerUserName: "Cosimo" }),
      ses({ sessionId: "s2", ownerUserName: "Tamsin" }),
    ]),
    traceState: traceState(BranchTraceCompletenessState.Incomplete),
  },
};

export const UnavailableCoverage: Story = {
  args: {
    detail: detail([ses({ sessionId: "s1", ownerUserName: "Cosimo" })]),
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
