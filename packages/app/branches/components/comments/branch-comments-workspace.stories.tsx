import {
  BranchCommentsState,
  BranchPrCommentKind,
} from "@repo/api/src/types/branch";
import {
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import type { Meta, StoryObj } from "@storybook/react";
import { useRef, useState } from "react";
import { fn } from "storybook/test";
import {
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentsWorkspaceProps,
  type BranchCommentThread,
} from "./branch-comments-model";
import {
  BRANCH_COMMENTS_MAX_WIDTH,
  BRANCH_COMMENTS_MIN_WIDTH,
} from "./branch-comments-rail";
import { BranchCommentsWorkspace } from "./branch-comments-workspace";

/**
 * This is the comments panel that sits beside a branch: a list of threads,
 * both pull request comments and comments tied to a session, a composer for
 * replying or starting a new thread, and a header count of how many are
 * showing. Reach for it instead of a generic comment list because it
 * understands context: which tab you are on and which sessions are actually
 * on screen decide which threads count, so the number shown can be lower
 * than the branch's true total. Comments that came from the pull request
 * provider itself are always read-only here; only threads created in this
 * workspace can be edited or deleted.
 */
const meta = {
  component: BranchCommentsWorkspace,
  decorators: [
    (Story) => (
      <div className="flex h-[42rem] justify-end bg-background">
        <Story />
      </div>
    ),
  ],
  title: "Surfaces/Comments Workspace",
  tags: ["autodocs"],
  argTypes: {
    activeTab: {
      control: { type: "radio" },
      options: Object.values(BranchCommentsTab),
      table: { category: "State" },
    },
    branchId: { control: "text", table: { category: "Data" } },
    comments: { control: "object", table: { category: "Data" } },
    composerTarget: {
      control: "object",
      description: "Anchor and target the new-comment composer writes against.",
      table: { category: "Data" },
    },
    coverageNote: {
      control: "text",
      description: "Disclosure shown when some Sessions could not be rendered.",
      table: { category: "Content" },
    },
    hasError: { control: "boolean", table: { category: "State" } },
    isLoading: { control: "boolean", table: { category: "State" } },
    onClose: { control: false, table: { category: "Events" } },
    onCreate: { control: false, table: { category: "Events" } },
    onDeleteReply: { control: false, table: { category: "Events" } },
    onDeleteThread: { control: false, table: { category: "Events" } },
    onEditRoot: { control: false, table: { category: "Events" } },
    onJump: { control: false, table: { category: "Events" } },
    onReply: { control: false, table: { category: "Events" } },
    onWidthChange: { control: false, table: { category: "Events" } },
    open: { control: "boolean", table: { category: "State" } },
    providerAvailability: {
      control: "object",
      description: "Bounded-coverage facts for the selected provider result.",
      table: { category: "Data" },
    },
    railId: { control: "text", table: { category: "State" } },
    renderBody: { control: false, table: { category: "Content" } },
    renderedSessionIds: {
      control: "object",
      description: "Session ids the timeline actually rendered.",
      table: { category: "Data" },
    },
    returnFocusRef: { control: false, table: { category: "Data" } },
    selectedPullRequestKey: { control: "text", table: { category: "Data" } },
    width: {
      control: {
        type: "range",
        min: BRANCH_COMMENTS_MIN_WIDTH,
        max: BRANCH_COMMENTS_MAX_WIDTH,
        step: 4,
      },
      table: { category: "State" },
    },
  },
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
      target: { id: "session-a", type: TraceCommentTargetType.Session },
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
      target: { id: "branch-1", type: TraceCommentTargetType.Branch },
    },
    hasError: false,
    isLoading: false,
    onClose: fn(),
    onCreate: fn(() => Promise.resolve()),
    onDeleteReply: fn(() => Promise.resolve()),
    onDeleteThread: fn(() => Promise.resolve()),
    onEditRoot: fn(() => Promise.resolve()),
    onJump: fn(),
    onReply: fn(() => Promise.resolve()),
    onWidthChange: fn(),
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
      collectionQuery: { surface: TraceCommentSurface.BranchTimeline },
      id: "timeline-thread",
      tab: BranchCommentsTab.Sessions,
    },
    {
      ...detailsThread,
      anchor: makeStoryAnchor("Session A, line 8", "session-anchor"),
      id: "session-thread",
      tab: BranchCommentsTab.Sessions,
      target: { id: "session-a", type: TraceCommentTargetType.Session },
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
    target: { id: "branch-1", type: TraceCommentTargetType.Branch },
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
    target: { id: "branch-1", type: TraceCommentTargetType.Branch },
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
