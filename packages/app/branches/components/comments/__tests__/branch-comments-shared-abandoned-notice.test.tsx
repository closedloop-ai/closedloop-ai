/**
 * @file branch-comments-shared-abandoned-notice.test.tsx
 * @description ISS-10383 AC3: the Branch comment card and the Sessions rail must
 * reach ONE `SyncAbandonedNotice`, not two that can drift.
 *
 * Asserting that by rendering both and comparing their output cannot distinguish
 * a shared component from a faithful copy — the copy passes on the day it is
 * made, and only diverges later. So the shared module is REPLACED with a
 * sentinel: a surface that reaches the shared owner renders the sentinel, and a
 * surface carrying its own copy renders the real badge instead. Both halves are
 * asserted on each surface, because the sentinel appearing does not by itself
 * rule out a second copy rendering beside it.
 *
 * The Sessions rail is imported across the slice boundary deliberately: this is
 * the one question that is about BOTH consumers of the shared module at once, and
 * splitting it per slice would leave neither file able to ask it.
 */

import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import type { TraceCommentItem } from "@repo/app/agents/components/detail/trace-comments";
import { TraceCommentsRail } from "@repo/app/agents/components/detail/trace-comments-rail";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BranchCommentCard } from "../branch-comment-card";
import {
  BranchCommentSource,
  BranchCommentsTab,
  type BranchCommentThread,
} from "../branch-comments-model";

/** Written here, never derived from the module under test. */
const SENTINEL = "shared-sync-abandoned-notice";
const REAL_BADGE_TEXT = "Sync failed";

vi.mock("@repo/app/shared/trace-comments/sync-abandoned-notice", () => ({
  // Echoes EVERY prop, so a host that reaches the shared module but never
  // threads one of them in cannot pass by rendering the sentinel alone. ISS-10827
  // added `isAuthor`: a guard that does not carry it would stay green while the
  // two hosts told opposite audiences apart differently, which is the drift this
  // file exists to catch.
  SyncAbandonedNotice: ({
    commentId,
    isAuthor,
    onRetrySync,
  }: {
    commentId: string;
    isAuthor: boolean;
    onRetrySync?: (commentId: string) => void;
  }) => (
    <span>{`${SENTINEL}:${commentId}:${isAuthor ? "author" : "reader"}:${onRetrySync ? "can" : "cannot"}`}</span>
  ),
}));

const mockUseOrganizationUsers = vi.fn();
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (options?: { enabled?: boolean }) =>
    mockUseOrganizationUsers(options),
}));

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({ data: [] });
});

describe("SyncAbandonedNotice has one owner (ISS-10383 AC3)", () => {
  it("renders the Branch comment card's notice from the shared module", () => {
    render(
      <BranchCommentCard
        canEditRoot
        canReply={false}
        draftFor={() => undefined}
        isPending={() => false}
        onCancelComposer={vi.fn()}
        onOpenComposer={vi.fn()}
        onRetrySync={vi.fn()}
        onSubmitComposer={vi.fn()}
        onUpdateDraft={vi.fn()}
        thread={makeThread()}
      />
    );

    expect(
      screen.getByText(`${SENTINEL}:thread-1:author:can`)
    ).toBeInTheDocument();
    expect(screen.queryByText(REAL_BADGE_TEXT)).not.toBeInTheDocument();
  });

  it("renders the Sessions rail's notice from the same shared module", () => {
    render(
      <TraceCommentsRail
        comments={[makeItem()]}
        onJump={vi.fn()}
        onRetrySync={vi.fn()}
      />
    );

    expect(
      screen.getByText(`${SENTINEL}:comment-1:author:can`)
    ).toBeInTheDocument();
    expect(screen.queryByText(REAL_BADGE_TEXT)).not.toBeInTheDocument();
  });
});

function makeThread(): BranchCommentThread {
  return {
    anchor: null,
    author: { avatarUrl: null, id: "maya", name: "Maya Chen" },
    body: "Branch note",
    canDeleteThread: false,
    // ISS-10827: the AUTHOR. `canRetrySync: true` below is only reachable for
    // one — `canRetrySyncFor` conjoins `comment.canEdit` — so the previous
    // `false` paired a reader with a working retry door, a combination
    // production cannot make and the sibling suite now refuses.
    canEditRoot: true,
    canReply: false,
    createdAtLabel: "10:00 AM",
    id: "thread-1",
    replies: [],
    canRetrySync: true,
    source: BranchCommentSource.Platform,
    syncAbandoned: true,
    tab: BranchCommentsTab.Details,
    target: { id: "branch-1", type: CommentTargetType.Branch },
  };
}

function makeItem(): TraceCommentItem {
  const createdAt = "2026-06-26T15:00:00.000Z";
  return {
    anchor: {
      actor: null,
      endOffset: 20,
      row: 1,
      selectedText: "selected text",
      sessionId: "session-1",
      sourceText: "source selected text",
      startOffset: 7,
      traceId: "trace-1",
      turnId: "turn-1",
    },
    artifactId: "session-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body: "Session note",
    canDelete: false,
    canEdit: true,
    createdAt,
    createdAtLabel: "Just now",
    editedAt: null,
    id: "comment-1",
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: CommentSurface.SessionDetail,
    syncAbandoned: true,
    target: { type: CommentTargetType.Session, id: "session-1" },
    threadId: "thread-1",
    updatedAt: createdAt,
  };
}
