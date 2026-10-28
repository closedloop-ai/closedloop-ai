import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  FULL_CAPABILITIES,
  makeComment,
  makeThread,
} from "../comments-pane.fixtures";
import { PaneHost } from "../comments-pane.story-fixtures";
import type { CommentsPaneComposerRenderProps } from "../comments-pane-composer";
import {
  CommentsPaneLayout,
  CommentsPaneLoadStatus,
  NO_ANCHOR_STATE_LABELS,
} from "../comments-pane-model";

const MENTIONED = ["user-sam"];
const PICKED = ["user-picked"];

const THREAD = makeThread({
  id: "thread-1",
  comments: [
    makeComment({
      body: "Root @Sam",
      mentions: MENTIONED,
      threadId: "thread-1",
    }),
  ],
});

/** A host composer that keeps the mentions it was handed, else submits the ones "picked". */
function mentionComposer(props: CommentsPaneComposerRenderProps) {
  return (
    <button
      onClick={() =>
        props.onSubmit({
          body: `${props.value}!`,
          mentions: props.initialMentions ?? PICKED,
        })
      }
      type="button"
    >
      {`Send ${props.ariaLabel}`}
    </button>
  );
}

function renderPane(overrides: Partial<ComponentProps<typeof PaneHost>> = {}) {
  const props: ComponentProps<typeof PaneHost> = {
    anchorStateLabels: NO_ANCHOR_STATE_LABELS,
    capabilities: FULL_CAPABILITIES,
    composerTarget: { anchor: { kind: CommentAnchorKind.Artifact } },
    layout: CommentsPaneLayout.Wide,
    loadStatus: CommentsPaneLoadStatus.Ready,
    onCreateThread: vi.fn(),
    onEdit: vi.fn(),
    onOpenChange: vi.fn(),
    onReply: vi.fn(),
    onWidthChange: vi.fn(),
    open: true,
    renderComposer: mentionComposer,
    threads: [THREAD],
    width: 360,
    ...overrides,
  };
  render(<PaneHost {...props} />);
  return props;
}

describe("CommentsPane mentions (PLN-2162 decision 4)", () => {
  it("renders the host's composer for a new thread and sends its mentions", async () => {
    const user = userEvent.setup();
    const props = renderPane();

    await user.click(
      screen.getByRole("button", { name: "Send Add a comment" })
    );

    expect(props.onCreateThread).toHaveBeenCalledExactlyOnceWith({
      anchor: { kind: CommentAnchorKind.Artifact },
      body: "!",
      mentions: PICKED,
    });
  });

  it("sends a reply's mentions", async () => {
    const user = userEvent.setup();
    const props = renderPane();

    await user.click(screen.getByRole("button", { name: "Reply to comment" }));
    await user.click(
      screen.getByRole("button", { name: "Send Reply to comment" })
    );

    expect(props.onReply).toHaveBeenCalledExactlyOnceWith("thread-1", {
      body: "!",
      mentions: PICKED,
    });
  });

  it("hands an edit the comment's own mentions, so keeping them sends them", async () => {
    const user = userEvent.setup();
    const props = renderPane();

    await user.click(screen.getByRole("button", { name: "Edit comment" }));
    await user.click(screen.getByRole("button", { name: "Send Edit comment" }));

    expect(props.onEdit).toHaveBeenCalledExactlyOnceWith(
      THREAD.comments[0]?.id,
      {
        body: "Root @Sam!",
        expectedRevision: 1,
        mentions: MENTIONED,
      }
    );
  });
});
