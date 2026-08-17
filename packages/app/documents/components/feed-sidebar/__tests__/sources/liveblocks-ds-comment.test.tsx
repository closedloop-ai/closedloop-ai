// @vitest-environment jsdom
import type { CommentData } from "@liveblocks/client";
import { formatDateTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mockUseUser = vi.fn();
vi.mock("@liveblocks/react", () => ({
  useUser: (userId: string) => mockUseUser(userId),
}));

// Capture the props the DS override forwards to Liveblocks' own <Comment>
// primitive, and render its native body so the mention/mark-preservation
// contract can be asserted from the rendered output.
const commentSpy = vi.fn();
vi.mock("@liveblocks/react-ui", () => ({
  Comment: (props: {
    comment: { body?: { text?: string } };
    body?: ReactNode;
    avatar?: ReactNode;
    author?: ReactNode;
    date?: ReactNode;
  }) => {
    commentSpy(props);
    return (
      <div data-testid="lb-comment">
        {props.avatar}
        {props.author}
        {props.date}
        <div data-testid="lb-comment-body">
          {/* When the override does NOT supply a `body`, the native rich body
              renders — modeled here by echoing the comment's own body. */}
          {props.body ?? <span>{props.comment.body?.text}</span>}
        </div>
      </div>
    );
  },
}));

import { LiveblocksDsComment } from "../../sources/liveblocks-ds-comment";

const EDITED_MARKER_PATTERN = /\(edited\)/;

function makeComment(overrides: Partial<CommentData> = {}): CommentData {
  return {
    type: "comment",
    id: "c_1",
    threadId: "th_1",
    roomId: "room_1",
    userId: "u_1",
    createdAt: new Date("2026-05-18T14:00:00Z"),
    reactions: [],
    attachments: [],
    metadata: {},
    body: {
      version: 1,
      content: [{ type: "paragraph", children: [{ text: "hello @Alice" }] }],
      // `text` is a test-only convenience read by the mock body renderer.
      text: "hello @Alice",
    },
    ...overrides,
  } as unknown as CommentData;
}

describe("LiveblocksDsComment", () => {
  it("renders the resolved author name and delegates the body to the native <Comment>", () => {
    mockUseUser.mockReturnValue({
      user: { name: "Alice", avatar: "https://example.com/a.png" },
      isLoading: false,
      error: undefined,
    });
    render(<LiveblocksDsComment comment={makeComment()} />);

    expect(screen.getByText("Alice")).toBeInTheDocument();
    // The rich body renders via the native primitive — mentions/marks are not
    // flattened by the DS chrome. The override must NOT pass a `body` prop.
    expect(commentSpy).toHaveBeenCalledTimes(1);
    expect(commentSpy.mock.calls[0][0].body).toBeUndefined();
    expect(screen.getByTestId("lb-comment-body")).toHaveTextContent(
      "hello @Alice"
    );
  });

  it("shows a neutral loading placeholder (never the raw user id) while resolving", () => {
    mockUseUser.mockReturnValue({
      user: undefined,
      isLoading: true,
      error: undefined,
    });
    render(<LiveblocksDsComment comment={makeComment({ userId: "u_42" })} />);

    // The raw Liveblocks id must never leak into the thread.
    expect(screen.queryByText("u_42")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("renders 'Unknown user' when the resolver cannot find the id", () => {
    mockUseUser.mockReturnValue({
      user: undefined,
      isLoading: false,
      error: undefined,
    });
    render(<LiveblocksDsComment comment={makeComment({ userId: "u_gone" })} />);

    expect(screen.queryByText("u_gone")).not.toBeInTheDocument();
    expect(screen.getByText("Unknown user")).toBeInTheDocument();
  });

  it("marks edited comments and keeps the exact-timestamp tooltip on the relative date", () => {
    mockUseUser.mockReturnValue({
      user: { name: "Alice", avatar: undefined },
      isLoading: false,
      error: undefined,
    });
    render(
      <LiveblocksDsComment
        comment={makeComment({ editedAt: new Date("2026-05-18T15:00:00Z") })}
      />
    );

    const date = screen.getByText(EDITED_MARKER_PATTERN);
    expect(date).toBeInTheDocument();
    // The exact-timestamp tooltip mirrors the DB-projected artifact card.
    expect(date).toHaveAttribute(
      "title",
      formatDateTimeOrFallback(new Date("2026-05-18T14:00:00Z"))
    );
  });

  it("steps replies down to the xs avatar so root/reply treatment matches the artifact card", () => {
    mockUseUser.mockReturnValue({
      user: { name: "Alice", avatar: undefined },
      isLoading: false,
      error: undefined,
    });
    const { container, rerender } = render(
      <LiveblocksDsComment aria-posinset={1} comment={makeComment()} />
    );
    // Root comment: sm avatar box (h-7 w-7).
    expect(container.querySelector(".h-7")).not.toBeNull();
    expect(container.querySelector(".h-5")).toBeNull();

    rerender(<LiveblocksDsComment aria-posinset={2} comment={makeComment()} />);
    // Reply: xs avatar box (h-5 w-5).
    expect(container.querySelector(".h-5")).not.toBeNull();
    expect(container.querySelector(".h-7")).toBeNull();
  });
});
