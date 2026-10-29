import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceCommentItem } from "../trace-comments";
import { TraceCommentsRail } from "../trace-comments-rail";

/**
 * ISS-11004: the rail half of the Activity tab's comment links. A `?comment=`
 * link addresses one THREAD; the rail marks it and brings it into view.
 *
 * `makeComment` gives each card an `id` and a DIFFERENT `threadId`, the shape
 * the real columns have. Addressing `thread-c-2` therefore fails if the rail
 * matches a card's own comment id, which is the defect this suite pins.
 *
 * `scrollIntoView` is not implemented in jsdom, so the suite installs it and
 * reads the calls — the reveal is the behaviour under test, not a side effect.
 */
const mockUseOrganizationUsers = vi.fn();
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => mockUseOrganizationUsers(),
}));

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({ data: [] });
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
    writable: true,
  });
});

afterEach(() => {
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.restoreAllMocks();
});

function rail(selectedThreadId?: string | null) {
  return (
    <TraceCommentsRail
      comments={[
        makeComment("c-1", "First trace note"),
        makeComment("c-2", "Second trace note"),
      ]}
      onJump={vi.fn()}
      selectedThreadId={selectedThreadId}
    />
  );
}

function cardFor(body: string): HTMLElement {
  const card = screen.getByText(body).closest("[data-comment-thread-id]");
  if (!(card instanceof HTMLElement)) {
    throw new Error(`No comment card rendered for ${body}`);
  }
  return card;
}

describe("TraceCommentsRail addressed comment", () => {
  it("marks the addressed thread in the accessibility tree, not by colour alone", () => {
    render(rail("thread-c-2"));

    expect(cardFor("Second trace note")).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(cardFor("First trace note")).not.toHaveAttribute("aria-current");
  });

  it("brings the addressed thread into view", () => {
    render(rail("thread-c-2"));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.instances[0]).toBe(cardFor("Second trace note"));
  });

  it("leaves the rail untouched when no comment is addressed", () => {
    render(rail(null));

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      screen.queryByText("First trace note")?.closest("[aria-current]")
    ).toBeNull();
  });

  /**
   * The rail re-renders on every comment refresh. Re-revealing on each one would yank a
   * reader who has scrolled away since following the link, so the reveal fires
   * once per address — the counterfactual is the re-address case below.
   */
  it("reveals once per address, not on every re-render", () => {
    const view = render(rail("thread-c-2"));
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    view.rerender(rail("thread-c-2"));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("reveals again when a different comment is addressed", () => {
    const view = render(rail("thread-c-2"));
    view.rerender(rail("thread-c-1"));

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollIntoView.mock.instances[1]).toBe(cardFor("First trace note"));
  });

  it("reveals again when the same comment is re-addressed after being cleared", () => {
    const view = render(rail("thread-c-2"));
    view.rerender(rail(null));
    view.rerender(rail("thread-c-2"));

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("waits for the addressed comment to arrive before revealing it", () => {
    const view = render(
      <TraceCommentsRail
        comments={[]}
        onJump={vi.fn()}
        selectedThreadId="thread-c-2"
      />
    );
    expect(scrollIntoView).not.toHaveBeenCalled();

    view.rerender(rail("thread-c-2"));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

function makeComment(id: string, body: string): TraceCommentItem {
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
    body,
    canDelete: false,
    canEdit: false,
    createdAt: "2026-06-26T15:00:00.000Z",
    createdAtLabel: "just now",
    editedAt: null,
    id,
    kind: TraceCommentKind.Comment,
    replies: [],
    resolvedAt: null,
    resolvedByAvatarUrl: null,
    resolvedById: null,
    resolvedByName: null,
    status: ThreadStatus.Open,
    surface: CommentSurface.SessionDetail,
    target: { id: "session-1", type: CommentTargetType.Session },
    threadId: `thread-${id}`,
    updatedAt: "2026-06-26T15:00:00.000Z",
  };
}
