import {
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import { CommentSurface, CommentTargetType } from "@repo/api/src/types/comment";
import type { Meta, StoryObj } from "@storybook/react";
import { useRef, useState } from "react";
import {
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentsWorkspaceProps,
  type BranchCommentThread,
} from "./branch-comments-model";
import { BranchCommentsWorkspace } from "./branch-comments-workspace";

const meta = {
  component: BranchCommentsWorkspace,
  decorators: [
    (Story) => (
      <div className="flex h-[42rem] justify-end bg-background">
        <Story />
      </div>
    ),
  ],
  title: "Surfaces v1.0/Branches/Comments Workspace",
  tags: ["deprecated"],
} satisfies Meta<typeof BranchCommentsWorkspace>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Details: Story = {
  args: makeArgs(),
  render: (args) => <WorkspaceStory args={args} />,
};

export const DetailsWithBoundedProviderEvidence: Story = {
  args: makeArgs({
    providerAvailability: {
      bodyTruncatedCount: 2,
      mixedProjection: true,
      omittedComments: 3,
      providerTruncated: true,
      responseTruncated: false,
      stale: true,
      state: BranchCommentsState.StaleMixed,
    },
    width: 340,
  }),
  render: (args) => <WorkspaceStory args={args} />,
};

export const SessionsWithIncompleteCoverage: Story = {
  args: makeArgs({
    activeTab: BranchCommentsTab.Sessions,
    comments: makeSessionThreads(),
    composerTarget: {
      anchor: makeStoryAnchor("Session A, line 8", "session-anchor"),
      target: { id: "session-a", type: CommentTargetType.Session },
    },
    coverageNote:
      "Comments from Session B are unavailable because that Session did not render.",
    renderedSessionIds: ["session-a"],
  }),
  render: (args) => <WorkspaceStory args={args} />,
};

export const Empty: Story = {
  args: makeArgs({ comments: [], composerTarget: null }),
  render: (args) => <WorkspaceStory args={args} />,
};

/**
 * Read {@link Loading}, {@link Unavailable}, and {@link Empty} together: three
 * states one heading has to keep apart. A read in flight leaves the count slot
 * to a skeleton and says "Loading comments…" once; only a failed read is
 * allowed to put the word "Unavailable" where a count normally sits (ISS-7370).
 */
export const Loading: Story = {
  args: makeArgs({ comments: [], composerTarget: null, isLoading: true }),
  render: (args) => <WorkspaceStory args={args} />,
};

export const Unavailable: Story = {
  args: makeArgs({ comments: [], composerTarget: null, hasError: true }),
  render: (args) => <WorkspaceStory args={args} />,
};

/**
 * The longer "Session Comments" title moves the skeleton's x position, and a
 * coverage note is the busiest that header row ever gets — "N shown" is the
 * widest thing the count slot holds, so this is where the skeleton's width has
 * to still read as the missing count rather than as a chip.
 */
export const LoadingSessionsWithCoverageNote: Story = {
  args: makeArgs({
    activeTab: BranchCommentsTab.Sessions,
    comments: [],
    composerTarget: null,
    coverageNote:
      "Comments from Session B are unavailable because that Session did not render.",
    isLoading: true,
  }),
  render: (args) => <WorkspaceStory args={args} />,
};

/**
 * A refresh reloading over comments already on screen. Both flags are set and
 * neither is allowed to speak: the real count stays, no skeleton appears, and
 * the threads keep painting.
 */
export const RefreshOverVisibleComments: Story = {
  args: makeArgs({ hasError: true, isLoading: true }),
  render: (args) => <WorkspaceStory args={args} />,
};

function WorkspaceStory({ args }: { args: BranchCommentsWorkspaceProps }) {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(args.width);
  const toggleRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        aria-controls="story-branch-comments"
        aria-expanded={open}
        className="self-start p-2 text-sm underline"
        onClick={() => setOpen((current) => !current)}
        ref={toggleRef}
        type="button"
      >
        {open ? "Hide comments" : "Show comments"}
      </button>
      <BranchCommentsWorkspace
        {...args}
        onClose={() => setOpen(false)}
        onWidthChange={setWidth}
        open={open}
        railId="story-branch-comments"
        returnFocusRef={toggleRef}
        width={width}
      />
    </>
  );
}

function makeArgs(
  overrides: Partial<BranchCommentsWorkspaceProps> = {}
): BranchCommentsWorkspaceProps {
  return {
    activeTab: BranchCommentsTab.Details,
    branchId: "branch-1",
    comments: [makeDetailsThread(), makeProviderThread()],
    composerTarget: {
      anchor: makeStoryAnchor("Branch trace, line 42", "detail-anchor"),
      target: { id: "branch-1", type: CommentTargetType.Branch },
    },
    onClose: () => undefined,
    onCreate: () => Promise.resolve(),
    onDeleteReply: () => Promise.resolve(),
    onDeleteThread: () => Promise.resolve(),
    onEditRoot: () => Promise.resolve(),
    onJump: () => undefined,
    onReply: () => Promise.resolve(),
    onWidthChange: () => undefined,
    open: true,
    renderedSessionIds: ["session-a"],
    returnFocusRef: { current: null },
    selectedPullRequestKey: "owner/repo#12",
    width: 380,
    ...overrides,
  };
}

function makeSessionThreads(): BranchCommentThread[] {
  const detailsThread = makeDetailsThread();
  return [
    {
      ...detailsThread,
      collectionQuery: { surface: CommentSurface.BranchTimeline },
      id: "timeline-thread",
      tab: BranchCommentsTab.Sessions,
    },
    {
      ...detailsThread,
      anchor: makeStoryAnchor("Session A, line 8", "session-anchor"),
      id: "session-thread",
      tab: BranchCommentsTab.Sessions,
      target: { id: "session-a", type: CommentTargetType.Session },
    },
  ];
}

function makeDetailsThread(): BranchCommentThread {
  return {
    anchor: makeStoryAnchor("Branch trace, line 42", "detail-anchor"),
    author: { id: "maya", name: "Maya Chen" },
    body: "The retry path now keeps the selected pull request context.",
    canDeleteThread: true,
    canEditRoot: true,
    canReply: true,
    createdAtLabel: "10:14 AM",
    id: "detail-thread",
    replies: [
      {
        author: { id: "lee", name: "Lee Park" },
        body: "Confirmed in the Desktop adapter too.",
        canDelete: false,
        createdAtLabel: "10:21 AM",
        id: "detail-reply",
      },
    ],
    source: BranchCommentSource.Platform,
    tab: BranchCommentsTab.Details,
    target: { id: "branch-1", type: CommentTargetType.Branch },
  };
}

function makeProviderThread(): BranchCommentThread {
  return {
    anchor: null,
    author: { id: "reviewer", name: "GitHub reviewer" },
    body: "Could we keep the historical selection pinned during refresh?",
    canDeleteThread: false,
    canEditRoot: false,
    canReply: false,
    createdAtLabel: "Yesterday",
    id: "provider-thread",
    provider: {
      bodyTruncated: true,
      inReplyToId: null,
      kind: BranchPrCommentKind.Review,
      line: 42,
      login: "reviewer-with-a-long-login",
      path: "packages/app/branches/components/comments/branch-comments-workspace.tsx",
      providerUrl: "https://github.com/owner/repo/pull/12#discussion_r42",
      resolved: false,
      stale: true,
      threadId: "provider-thread",
    },
    pullRequestKey: "owner/repo#12",
    replies: [
      {
        author: { id: "reply-reviewer", name: "reply-reviewer" },
        body: "The reply carries independent provenance.",
        canDelete: false,
        createdAtLabel: "Today",
        id: "provider-reply",
        provider: {
          bodyTruncated: true,
          inReplyToId: "provider-thread",
          kind: BranchPrCommentKind.ReviewReply,
          line: 43,
          login: "reply-reviewer",
          path: "packages/app/branches/components/comments/branch-comments-workspace.tsx",
          providerUrl: "https://github.com/owner/repo/pull/12#discussion_r43",
          resolved: true,
          stale: true,
          threadId: "provider-thread",
        },
      },
    ],
    source: BranchCommentSource.Provider,
    tab: BranchCommentsTab.Details,
    target: { id: "branch-1", type: CommentTargetType.Branch },
  };
}

function makeStoryAnchor(label: string, id: string) {
  return {
    id,
    label,
    trace: {
      actor: null,
      endOffset: 20,
      row: 42,
      sessionId: "session-a",
      selectedText: "selected trace text",
      sourceText: "source selected trace text",
      startOffset: 0,
      traceId: "trace-1",
      turnId: "turn-1",
    },
  };
}
