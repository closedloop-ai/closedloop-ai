import { BranchPrCommentKind } from "@repo/api/src/types/branch";
import { CommentTargetType } from "@repo/api/src/types/comment";
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
import { BRANCH_COMMENTS_MIN_WIDTH } from "./branch-comments-rail";

const COMMENT_PHOTO_URL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23ddd6fe'/%3E%3Ccircle cx='20' cy='15' r='8' fill='%235b21b6'/%3E%3Cpath d='M5 40c2-10 8-15 15-15s13 5 15 15' fill='%235b21b6'/%3E%3C/svg%3E";
const FAILED_PHOTO_URL = "data:image/png;base64,broken";

/**
 * One comment thread card: a platform-authored root with inline reply/edit
 * composers, or a read-only provider (GitHub) thread with its own reply
 * metadata. `mode` selects which composer, if any, is open for the root.
 * No controls: each story is a complete thread fixture whose nested author,
 * permission and composer state must stay coherent.
 */
const meta = {
  component: BranchCommentCard,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-md bg-background p-6">
        <Story />
      </div>
    ),
  ],
  title: "Composites v1.0/Branches/Branch Comment Card",
  tags: ["deprecated", "autodocs"],
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

export const PlatformPhoto: Story = {
  args: { thread: withAuthorAvatar(makePlatformThread(), COMMENT_PHOTO_URL) },
};

export const PlatformFailedPhoto: Story = {
  args: { thread: withAuthorAvatar(makePlatformThread(), FAILED_PHOTO_URL) },
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

/*
 * ISS-10383: the two states the dead-letter affordance adds to the metadata
 * row, which sits beside the timestamp and is therefore the line that crowds
 * first. The suites around this card pin STRINGS; `packages/app/AGENTS.md` is
 * explicit that narrow-width crowding and tone pairing are pinned here instead,
 * and the Sessions rail never got a story either, so this is the shared
 * component's only rendered-state coverage on either surface (marisolashgrove
 * review).
 */
export const SyncAbandonedWithRetry: Story = {
  args: {
    thread: {
      ...makePlatformThread(),
      canRetrySync: true,
      syncAbandoned: true,
    },
  },
};

/*
 * The honest render for a row nothing can move — a provider thread, whose
 * source never exposes `retrySync`. Badge, no door. Rendered at the rail's real
 * floor rather than the default `max-w-md`, because that is the width at which
 * the badge, the button and the timestamp have to share one line.
 */
export const SyncAbandonedWithoutRetryAtMinWidth: Story = {
  decorators: [
    (Story) => (
      <div
        className="bg-background p-6"
        style={{ width: BRANCH_COMMENTS_MIN_WIDTH }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    canEditRoot: false,
    canReply: false,
    thread: {
      ...makeProviderThread(),
      canRetrySync: false,
      syncAbandoned: true,
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
    target: { id: "branch-1", type: CommentTargetType.Branch },
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

function withAuthorAvatar(
  thread: BranchCommentThread,
  avatarUrl: string
): BranchCommentThread {
  return {
    ...thread,
    author: { ...thread.author, avatarUrl },
  };
}
