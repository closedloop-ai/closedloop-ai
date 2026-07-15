import {
  ThreadStatus,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TraceCommentItem } from "../trace-comments";
import { TraceCommentsRail } from "../trace-comments-rail";

describe("TraceCommentsRail", () => {
  it("shows edit and delete controls for comments the viewer can mutate", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onUpdate = vi.fn();

    render(
      <TraceCommentsRail
        comments={[makeComment({ canDelete: true, canEdit: true })]}
        onDelete={onDelete}
        onJump={vi.fn()}
        onUpdate={onUpdate}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit trace note" }));
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Edited trace note");
    await user.click(screen.getByRole("button", { name: "Save trace note" }));
    await user.click(screen.getByRole("button", { name: "Delete trace note" }));

    expect(onUpdate).toHaveBeenCalledWith("comment-1", {
      body: "Edited trace note",
    });
    expect(onDelete).toHaveBeenCalledWith("comment-1");
  });

  it("submits replies and does not render a reaction action", async () => {
    const user = userEvent.setup();
    const onReply = vi.fn();

    render(
      <TraceCommentsRail
        comments={[makeComment({ canDelete: true, canEdit: true })]}
        onJump={vi.fn()}
        onReply={onReply}
      />
    );

    expect(
      screen.queryByRole("button", { name: "React to trace note" })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Reply to trace note" })
    );
    await user.type(
      screen.getByRole("textbox", { name: "Reply body" }),
      "Reply text"
    );
    await user.click(screen.getByRole("button", { name: "Save trace reply" }));

    expect(onReply).toHaveBeenCalledWith("comment-1", { body: "Reply text" });
  });

  it("deletes a reply the viewer owns via the reply delete control", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    render(
      <TraceCommentsRail
        comments={[
          makeComment({
            canDelete: true,
            canEdit: true,
            replies: [makeReply({ canDelete: true })],
          }),
        ]}
        onDelete={onDelete}
        onJump={vi.fn()}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Delete trace reply" })
    );

    expect(onDelete).toHaveBeenCalledWith("reply-1");
  });

  it("does not show a reply delete control for replies owned by another user", () => {
    render(
      <TraceCommentsRail
        comments={[
          makeComment({
            canDelete: true,
            canEdit: true,
            replies: [makeReply({ canDelete: false })],
          }),
        ]}
        onDelete={vi.fn()}
        onJump={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Delete trace reply" })
    ).not.toBeInTheDocument();
  });

  it("does not show edit and delete controls for comments owned by another user", () => {
    render(
      <TraceCommentsRail
        comments={[makeComment({ canDelete: false, canEdit: false })]}
        onDelete={vi.fn()}
        onJump={vi.fn()}
        onUpdate={vi.fn()}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Edit trace note" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete trace note" })
    ).not.toBeInTheDocument();
  });
});

function makeComment(options: {
  canDelete: boolean;
  canEdit: boolean;
  replies?: TraceCommentItem["replies"];
}): TraceCommentItem {
  return {
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 1,
      selectedText: "selected text",
      sourceText: "source selected text",
      startOffset: 7,
      endOffset: 20,
      sessionId: "session-1",
      actor: null,
    },
    artifactId: "session-1",
    authorAvatarUrl: null,
    authorId: "user-1",
    authorName: "Test User",
    body: "Original trace note",
    canDelete: options.canDelete,
    canEdit: options.canEdit,
    createdAt: "2026-06-26T15:00:00.000Z",
    createdAtLabel: "Just now",
    editedAt: null,
    id: "comment-1",
    status: ThreadStatus.Open,
    surface: TraceCommentSurface.SessionDetail,
    target: { type: TraceCommentTargetType.Session, id: "session-1" },
    threadId: "thread-1",
    updatedAt: "2026-06-26T15:00:00.000Z",
    replies: options.replies ?? [],
  };
}

function makeReply(options: {
  canDelete: boolean;
}): TraceCommentItem["replies"][number] {
  return {
    authorAvatarUrl: null,
    authorId: "user-2",
    authorName: "Reply Author",
    body: "A reply",
    canDelete: options.canDelete,
    canEdit: false,
    createdAt: "2026-06-26T15:05:00.000Z",
    createdAtLabel: "Just now",
    editedAt: null,
    id: "reply-1",
    threadId: "thread-1",
    updatedAt: "2026-06-26T15:05:00.000Z",
  };
}
