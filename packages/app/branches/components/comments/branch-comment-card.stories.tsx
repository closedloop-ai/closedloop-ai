import { BranchPrCommentKind } from "@repo/api/src/types/branch";
import { TraceCommentTargetType } from "@repo/api/src/types/comment";
import type { Meta, StoryObj } from "@storybook/react";
import {
  BranchCommentCard,
  BranchCommentComposerKind,
} from "./branch-comment-card";
import {
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentThread,
} from "./branch-comments-model";

const meta = {
  component: BranchCommentCard,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-md bg-background p-6">
        <Story />
      </div>
    ),
  ],
  title: "App Core/Branches/Comment Card",
  args: {
    canEditRoot: true,
    canReply: true,
    draftFor: (_kind: BranchCommentComposerKind): string | undefined =>
      undefined,
    isPending: (_kind: BranchCommentComposerKind) => false,
    onCancelComposer: () => undefined,
    onDeleteReply: () => undefined,
    onDeleteThread: () => undefined,
    onJump: () => undefined,
    onOpenComposer: () => undefined,
    onSubmitComposer: () => undefined,
    onUpdateDraft: () => undefined,
    thread: makePlatformThread(),
  },
} satisfies Meta<typeof BranchCommentCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PlatformMidEdit: Story = {
  args: {
    draftFor: (kind) =>
      kind === BranchCommentComposerKind.Edit
        ? "The selected pull request remains pinned during refresh."
        : undefined,
    mode: {
      kind: BranchCommentComposerKind.Edit,
      threadId: "platform-thread",
    },
  },
};

export const PlatformMidReply: Story = {
  args: {
    draftFor: (kind) =>
      kind === BranchCommentComposerKind.Reply
        ? "Confirmed in the Desktop adapter too."
        : undefined,
    mode: {
      kind: BranchCommentComposerKind.Reply,
      threadId: "platform-thread",
    },
  },
};

export const ProviderWithGitHubLink: Story = {
  args: {
    canEditRoot: false,
    canReply: false,
    thread: {
      ...makeProviderThread(),
      anchor: makeStoryAnchor(),
    },
  },
};

export const ThreadWithoutAnchor: Story = {
  args: {
    thread: {
      ...makePlatformThread(),
      anchor: null,
    },
  },
};

function makePlatformThread(): BranchCommentThread {
  return {
    anchor: makeStoryAnchor(),
    author: { id: "maya", name: "Maya Chen" },
    body: "The retry path now keeps the selected pull request context.",
    canDeleteThread: true,
    canEditRoot: true,
    canReply: true,
    createdAtLabel: "10:14 AM",
    id: "platform-thread",
    replies: [
      {
        author: { id: "lee", name: "Lee Park" },
        body: "Confirmed in the Desktop adapter too.",
        canDelete: true,
        createdAtLabel: "10:21 AM",
        id: "platform-reply",
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
      path: "packages/app/branches/components/comments/branch-comment-card.tsx",
      providerUrl: "https://github.com/owner/repo/pull/12#discussion_r42",
      resolved: false,
      stale: true,
      threadId: "provider-thread",
    },
    pullRequestKey: "owner/repo#12",
    replies: [
      {
        author: {
          id: "reply-reviewer",
          name: "reply-reviewer",
        },
        body: "Reply metadata and its own GitHub URL remain visible.",
        canDelete: false,
        createdAtLabel: "Today",
        id: "provider-reply",
        provider: {
          bodyTruncated: false,
          inReplyToId: "provider-thread",
          kind: BranchPrCommentKind.ReviewReply,
          line: 43,
          login: "reply-reviewer",
          path: "packages/app/branches/components/comments/branch-comment-card.tsx",
          providerUrl: "https://github.com/owner/repo/pull/12#discussion_r43",
          resolved: true,
          stale: false,
          threadId: "provider-thread",
        },
      },
    ],
    source: BranchCommentSource.Provider,
    tab: BranchCommentsTab.Details,
    target: { id: "branch-1", type: TraceCommentTargetType.Branch },
  };
}

function makeStoryAnchor() {
  return {
    id: "branch-trace-anchor",
    label: "Branch trace, line 42",
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
