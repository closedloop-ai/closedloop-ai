import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceCommentItem } from "../trace-comments";
import { TraceCommentsRail } from "../trace-comments-rail";

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

/** Matches a comment body ending in "comment" for stable DOM-order assertions. */
const COMMENT_BODY_RE = /comment$/;
/** Matches either sort-button accessible name regardless of the active order. */
const SORT_BUTTON_RE = /^Sort comments/;
const AUTHOR_NAME = "Dana Reed";
const AUTHOR_AVATAR_URL = "https://example.test/dana.png";
/**
 * `personInitials` is design-system-private, so the expected initial is
 * spelled. One initial on every avatar (Nerys, 2026-10-22).
 */
const AUTHOR_INITIALS = "D";

const mockUseOrganizationUsers = vi.fn();
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (options?: { enabled?: boolean }) =>
    mockUseOrganizationUsers(options),
}));

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({ data: [] });
});

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
    // The canonical MentionComposer opens seeded with the existing body.
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Edited trace note");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("button", { name: "Delete trace note" }));

    expect(onUpdate).toHaveBeenCalledWith("comment-1", {
      body: "Edited trace note",
      mentions: [],
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
      screen.getByRole("textbox", { name: "Reply..." }),
      "Reply text"
    );
    await user.click(screen.getByRole("button", { name: "Reply" }));

    expect(onReply).toHaveBeenCalledWith("comment-1", {
      body: "Reply text",
      mentions: [],
    });
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

  describe("sort control", () => {
    // Two comments with distinct creation times and bodies so DOM order is
    // observable. `older` was created before `newer`.
    const older = () =>
      makeComment({
        body: "Older comment",
        canDelete: false,
        canEdit: false,
        createdAt: "2026-06-26T15:00:00.000Z",
        id: "comment-older",
      });
    const newer = () =>
      makeComment({
        body: "Newer comment",
        canDelete: false,
        canEdit: false,
        createdAt: "2026-06-26T16:00:00.000Z",
        id: "comment-newer",
      });

    const renderedBodyOrder = (): string[] =>
      screen
        .getAllByText(COMMENT_BODY_RE, { selector: ".fp-comment-text" })
        .map((node) => node.textContent ?? "");

    it("defaults to newest-first regardless of the incoming order", () => {
      // Feed the list oldest-first to prove the rail sorts rather than trusting
      // the incoming order.
      render(
        <TraceCommentsRail
          comments={[older(), newer()]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
        />
      );

      expect(renderedBodyOrder()).toEqual(["Newer comment", "Older comment"]);
      expect(
        screen.getByRole("button", { name: "Sort comments (newest first)" })
      ).toHaveAttribute("aria-pressed", "false");
    });

    it("reverses the rendered comment order when the sort button is clicked", async () => {
      const user = userEvent.setup();

      render(
        <TraceCommentsRail
          comments={[newer(), older()]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
        />
      );

      // Newest-first by default.
      expect(renderedBodyOrder()).toEqual(["Newer comment", "Older comment"]);

      await user.click(
        screen.getByRole("button", { name: "Sort comments (newest first)" })
      );

      // Now oldest-first; the label and pressed state reflect the flip.
      expect(renderedBodyOrder()).toEqual(["Older comment", "Newer comment"]);
      const toggled = screen.getByRole("button", {
        name: "Sort comments (oldest first)",
      });
      expect(toggled).toHaveAttribute("aria-pressed", "true");

      // Clicking again returns to newest-first.
      await user.click(toggled);
      expect(renderedBodyOrder()).toEqual(["Newer comment", "Older comment"]);
    });

    it("swaps to a directional glyph that signals the active sort order", async () => {
      const user = userEvent.setup();

      render(
        <TraceCommentsRail
          comments={[newer(), older()]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
        />
      );

      // Newest-first: descending (wide→narrow) glyph, so the icon itself — not
      // just the tint — communicates the order.
      const sortButton = () =>
        screen.getByRole("button", { name: SORT_BUTTON_RE });
      expect(sortButton().querySelector("svg")).toHaveClass(
        "lucide-arrow-down-wide-narrow"
      );
      expect(
        sortButton().querySelector(".lucide-arrow-up-narrow-wide")
      ).toBeNull();

      await user.click(sortButton());

      // Oldest-first: the glyph flips to ascending (narrow→wide).
      expect(sortButton().querySelector("svg")).toHaveClass(
        "lucide-arrow-up-narrow-wide"
      );
      expect(
        sortButton().querySelector(".lucide-arrow-down-wide-narrow")
      ).toBeNull();
    });

    it("resets to newest-first when the rail is pointed at a new trace target", async () => {
      const user = userEvent.setup();

      // The rail is reused across same-component session/branch navigation, so a
      // non-default order chosen for one target must not carry into the next.
      const { rerender } = render(
        <TraceCommentsRail
          comments={[newer(), older()]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
          traceIdentity="session-a"
        />
      );

      await user.click(
        screen.getByRole("button", { name: "Sort comments (newest first)" })
      );
      expect(renderedBodyOrder()).toEqual(["Older comment", "Newer comment"]);

      // Navigate to a different trace within the same mounted rail.
      rerender(
        <TraceCommentsRail
          comments={[newer(), older()]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
          traceIdentity="session-b"
        />
      );

      // Sort snaps back to the newest-first default for the new target.
      expect(renderedBodyOrder()).toEqual(["Newer comment", "Older comment"]);
      expect(
        screen.getByRole("button", { name: "Sort comments (newest first)" })
      ).toHaveAttribute("aria-pressed", "false");
    });
  });

  describe("mention chips (FEA-3490)", () => {
    it("renders @name chips resolved from mention IDs", () => {
      mockUseOrganizationUsers.mockReturnValue({
        data: [
          {
            id: "user-9",
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            avatarUrl: null,
            active: true,
          },
        ],
      });

      render(
        <TraceCommentsRail
          comments={[
            makeComment({
              canDelete: false,
              canEdit: false,
              mentions: ["user-9"],
            }),
          ]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
        />
      );

      const chips = screen.getByTestId("trace-mention-chips");
      expect(chips).toHaveTextContent("Ada Lovelace");
    });

    it("renders a reply's mention chip resolved from its mention IDs", () => {
      mockUseOrganizationUsers.mockReturnValue({
        data: [
          {
            id: "user-7",
            firstName: null,
            lastName: null,
            email: "grace@example.com",
            avatarUrl: null,
            active: true,
          },
        ],
      });

      render(
        <TraceCommentsRail
          comments={[
            makeComment({
              canDelete: false,
              canEdit: false,
              replies: [makeReply({ canDelete: false, mentions: ["user-7"] })],
            }),
          ]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
        />
      );

      // No name parts → falls back to email as the display label.
      expect(screen.getByText("grace@example.com")).toBeInTheDocument();
    });

    it("renders no chips for a comment without mentions", () => {
      render(
        <TraceCommentsRail
          comments={[makeComment({ canDelete: false, canEdit: false })]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
        />
      );

      // Chips are driven by persisted mentions, not a flag: absent mentions →
      // no chip container.
      expect(
        screen.queryByTestId("trace-mention-chips")
      ).not.toBeInTheDocument();
    });
  });

  describe("hover-reveal DOM contract (FEA-3929)", () => {
    it("renders the comment card with the class the CSS hover-reveal selector keys off, wrapping the actions row", () => {
      // styles.css reveals the actions row (`.fp-comment-actions`, incl. the
      // Reply button) on `.fp-comment-card:hover`/`:focus-within`. The dead
      // `.fp-comment` selector shipped for months matched no element, so hover
      // never revealed the row. This asserts the DOM contract the selector
      // depends on: the card element must carry `fp-comment-card` and contain
      // the actions row it reveals. The CSS→DOM computed-visibility behavior is
      // exercised in a real browser by e2e/session-detail.spec.ts.
      const { container } = render(
        <TraceCommentsRail
          comments={[makeComment({ canDelete: false, canEdit: false })]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
          onReply={vi.fn()}
        />
      );

      const card = container.querySelector<HTMLElement>(".fp-comment-card");
      expect(card).not.toBeNull();
      expect(card?.querySelector(".fp-comment-actions")).not.toBeNull();
    });
  });

  /*
   * ISS-12269 replaced a fixed glyph that named no one with the author's own
   * photo-or-initials. Every other fixture in this file carries
   * `authorAvatarUrl: null`, so without these two the photo arm was never
   * rendered and a fixed glyph could return green (tamsinb review, PR #8612).
   *
   * `AvatarImage` comes from `@repo/app/test/mocks/avatar-image`, whose
   * docstring carries the bound: real Radix gates on an image load jsdom cannot
   * supply, and the stand-in forwards only `alt` and `src`. So these claims are
   * scoped to the SOURCE and the fallback text; the unfiltered
   * accessible-name claim over real Radix belongs to an e2e.
   */
  describe("author avatar (ISS-12269)", () => {
    it("renders the comment author's own photo when one is served", () => {
      const { container } = render(
        <TraceCommentsRail
          comments={[
            makeComment({
              authorAvatarUrl: AUTHOR_AVATAR_URL,
              authorName: AUTHOR_NAME,
              canDelete: false,
              canEdit: false,
            }),
          ]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
          onReply={vi.fn()}
        />
      );

      expect(
        container.querySelector<HTMLImageElement>(".fp-comment-card img")?.src
      ).toBe(AUTHOR_AVATAR_URL);
    });

    it("falls back to the author's initials, not a fixed glyph, with no photo", () => {
      const { container } = render(
        <TraceCommentsRail
          comments={[
            makeComment({
              authorAvatarUrl: null,
              authorName: AUTHOR_NAME,
              canDelete: false,
              canEdit: false,
            }),
          ]}
          onDelete={vi.fn()}
          onJump={vi.fn()}
          onReply={vi.fn()}
        />
      );

      const card = container.querySelector<HTMLElement>(".fp-comment-card");
      expect(card?.querySelector("img")).toBeNull();
      // Derived from THIS author, so any fixed glyph — the retired one or a new
      // one — fails here rather than passing on a coincidence. Read off the
      // fallback itself: a lone "D" would also match the author's name.
      expect(
        card?.querySelector('[data-slot="avatar-fallback"]')?.textContent
      ).toBe(AUTHOR_INITIALS);
    });
  });
});

function makeComment(options: {
  canDelete: boolean;
  canEdit: boolean;
  authorAvatarUrl?: string | null;
  authorName?: string;
  body?: string;
  createdAt?: string;
  id?: string;
  mentions?: string[];
  replies?: TraceCommentItem["replies"];
}): TraceCommentItem {
  const createdAt = options.createdAt ?? "2026-06-26T15:00:00.000Z";
  return {
    mentions: options.mentions,
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
    authorAvatarUrl: options.authorAvatarUrl ?? null,
    authorId: "user-1",
    authorName: options.authorName ?? "Test User",
    body: options.body ?? "Original trace note",
    canDelete: options.canDelete,
    canEdit: options.canEdit,
    createdAt,
    createdAtLabel: "Just now",
    editedAt: null,
    id: options.id ?? "comment-1",
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    kind: TraceCommentKind.Comment,
    surface: CommentSurface.SessionDetail,
    target: { type: CommentTargetType.Session, id: "session-1" },
    threadId: "thread-1",
    updatedAt: createdAt,
    replies: options.replies ?? [],
  };
}

function makeReply(options: {
  canDelete: boolean;
  mentions?: string[];
}): TraceCommentItem["replies"][number] {
  return {
    mentions: options.mentions,
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
