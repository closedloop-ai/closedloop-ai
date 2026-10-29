import { CommentSurface } from "@repo/api/src/types/comment";
import {
  CommentsPaneOpenKey,
  CommentsPaneWidthKey,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyCommentsSource } from "../../../shared/comments/comments-story-source";
import {
  FULL_CAPABILITIES,
  githubThread,
  makeComment,
  makeThread,
  traceAnchor,
} from "../../../shared/components/comments/comments-pane.fixtures";
import { BranchCommentsPaneContent } from "./branch-comments-pane";

const BRANCH = "branch-artifact";
const SESSION = "session-a";
const SESSION_PASSAGE = "Re-ran the whole suite after the fix";

const BRANCH_THREADS = [
  githubThread("github-1", { artifactId: BRANCH }),
  makeThread({
    anchor: null,
    artifactId: BRANCH,
    comments: [
      makeComment({
        body: "Ready for review once the checks settle.",
        threadId: "branch-detail-1",
      }),
    ],
    id: "branch-detail-1",
    surface: CommentSurface.BranchDetail,
  }),
];
const SESSION_THREADS = [
  makeThread({
    anchor: traceAnchor(SESSION_PASSAGE, { row: 12, sessionId: SESSION }),
    artifactId: SESSION,
    comments: [
      makeComment({
        body: "The second pass doubled the cost of this Session.",
        threadId: "session-thread-1",
      }),
    ],
    id: "session-thread-1",
  }),
];

/**
 * The Branch's connected comments pane (PLN-2162 M6.2), against an in-memory
 * read-only port. Branch details lists GitHub and native Branch threads; the
 * Sessions tab lists the timeline's and every rendered Session's.
 *
 * Controls table:
 * | Prop / arg | Control | Why |
 * |---|---|---|
 * | activeTab | select | which shell tab the pane serves |
 * | selectedPullRequestKey | text | the Branch details PR scope |
 * | renderedSessions | object | the timeline's Sessions and coverage note |
 * | selectTabThenReveal, onRevealTraceAnchor | action | the shell's reveal and jump |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | dataSource, organizationId, branchArtifactId, composerTarget, returnFocusRef | fixed by the fixture port |
 */
const meta = {
  title: "Composites v1.0/Branches/Branch Comments Pane",
  component: BranchCommentsPaneContent,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  // The pane's saved state is per viewer; each story starts from the default.
  beforeEach: () => {
    for (const key of [
      CommentsPaneOpenKey.BranchArtifact,
      CommentsPaneOpenKey.BranchSessions,
      CommentsPaneWidthKey.BranchArtifact,
      CommentsPaneWidthKey.BranchSessions,
    ]) {
      globalThis.localStorage.removeItem(key);
    }
  },
  decorators: [
    (Story) => (
      <div className="flex h-[40rem] bg-background">
        <div className="flex-1" />
        <Story />
      </div>
    ),
  ],
  args: {
    activeTab: ArtifactDetailTab.Sessions,
    branchArtifactId: BRANCH,
    composerTarget: null,
    dataSource: storyCommentsSource({
      capabilities: FULL_CAPABILITIES,
      read: (targetId, options) => {
        if (targetId !== BRANCH) {
          return { artifactId: targetId, threads: SESSION_THREADS };
        }
        return {
          artifactId: BRANCH,
          threads:
            options.surface === CommentSurface.BranchTimeline
              ? []
              : BRANCH_THREADS,
        };
      },
    }),
    onRevealTraceAnchor: fn(),
    organizationId: null,
    renderedSessions: { coverageNote: null, sessionIds: [SESSION] },
    selectTabThenReveal: fn((_tab: string, reveal: () => void) => reveal()),
    selectedPullRequestKey: "closedloop-ai/closedloop-ai#1",
  },
  argTypes: {
    activeTab: {
      control: "select",
      options: [ArtifactDetailTab.Artifact, ArtifactDetailTab.Sessions],
    },
    renderedSessions: { control: "object" },
    selectedPullRequestKey: { control: "text" },
  },
} satisfies Meta<typeof BranchCommentsPaneContent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A Session thread's reveal selects the Sessions tab before the timeline scrolls. */
export const SessionsRevealSelectsTheTab: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: `Jump to ${SESSION_PASSAGE}` })
    );
    await expect(args.selectTabThenReveal).toHaveBeenCalledWith(
      ArtifactDetailTab.Sessions,
      expect.any(Function)
    );
    await expect(args.onRevealTraceAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ row: 12, sessionId: SESSION })
    );
    const [selected] = args.selectTabThenReveal.mock.invocationCallOrder;
    const [scrolled] = args.onRevealTraceAnchor.mock.invocationCallOrder;
    await expect(selected).toBeLessThan(scrolled ?? 0);
  },
};

/** Branch details: GitHub threads beside the native Branch ones. */
export const BranchDetails: Story = {
  args: { activeTab: ArtifactDetailTab.Artifact },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Ready for review once the checks settle.")
    ).toBeInTheDocument();
    await expect(
      canvas.getByText("Should this guard the empty anchor case too?")
    ).toBeInTheDocument();
  },
};
