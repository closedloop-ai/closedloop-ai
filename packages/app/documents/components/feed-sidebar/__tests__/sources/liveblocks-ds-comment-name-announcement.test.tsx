/**
 * ISS-7441: a comment row in the feed rail announces its author ONCE.
 *
 * This is the consumer half of the fix. `CommentAvatar` used to pass
 * `alt={author}` while this override renders the identical string in its
 * `author` slot, so a screen reader read the person twice on every comment row
 * with a photo — and, after ISS-5955 fixed the sibling `ActivityActor`, once on
 * an activity row and twice on a comment row in the same list. The photo's own
 * side of the contract is pinned in
 * `shared/components/__tests__/comment-avatar-name-announcement.test.tsx`; what
 * only this file can pin is that the row still says the name at all.
 *
 * The Liveblocks mocks mirror the sibling `liveblocks-ds-comment.test.tsx`
 * (`useUser` for the name/photo, `<Comment>` for the slots). `AvatarImage` is
 * mocked through `@repo/app/test/mocks/avatar-image`, whose docstring carries
 * the reason and the bounds.
 *
 * Restore `alt={author}` in `comment-avatar.tsx` and this file yields
 * `1 failed | 1 passed` — the accessibility-tree test, on `queryAllByRole`.
 * The photo-less test cannot go red on that mutation and does not claim to; it
 * pins the branch where the change had to be a no-op.
 */
import type { CommentData } from "@liveblocks/client";
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mockUseUser = vi.fn();
vi.mock("@liveblocks/react", () => ({
  useUser: (userId: string) => mockUseUser(userId),
}));

vi.mock("@liveblocks/react-ui", () => ({
  Comment: (props: {
    avatar?: ReactNode;
    author?: ReactNode;
    date?: ReactNode;
  }) => (
    <div data-testid="lb-comment">
      {props.avatar}
      {props.author}
      {props.date}
    </div>
  ),
}));

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

import { LiveblocksDsComment } from "../../sources/liveblocks-ds-comment";

const AUTHOR_NAME = "Dana Reed";
const AUTHOR_AVATAR_URL = "https://example.test/dana.png";

function makeComment(): CommentData {
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
    body: { version: 1, content: [] },
  } as unknown as CommentData;
}

describe("LiveblocksDsComment author announcement (ISS-7441)", () => {
  it("announces the author exactly once, beside a photo that is out of the accessibility tree", () => {
    mockUseUser.mockReturnValue({
      user: { name: AUTHOR_NAME, avatar: AUTHOR_AVATAR_URL },
      isLoading: false,
      error: undefined,
    });

    const { container } = render(
      <LiveblocksDsComment comment={makeComment()} />
    );

    // POSITIVE CONTROL. Without it the negative below is satisfied by a row
    // that rendered no photo at all.
    const photo = container.querySelector("img");
    expect(photo).not.toBeNull();
    expect(photo).toHaveAttribute("src", AUTHOR_AVATAR_URL);

    // Scoped to `alt`, and only `alt`: the stand-in above drops every other
    // image prop, so an `aria-label={author}` would leave this green (whitlockk,
    // PR #6640). The unfiltered claim against real Radix is
    // `e2e/sessions-owner-avatar-name.spec.ts`.
    expect(screen.queryAllByRole("img")).toHaveLength(0);

    // De-duplicating must not delete the only statement. Exactly one —
    // `toHaveLength(1)`, never `toBeInTheDocument()`, because "present" is
    // what the defect also satisfied.
    expect(screen.getAllByText(AUTHOR_NAME, { exact: true })).toHaveLength(1);
  });

  it("still names a photo-less author once, with no image involved", () => {
    mockUseUser.mockReturnValue({
      user: { name: AUTHOR_NAME, avatar: undefined },
      isLoading: false,
      error: undefined,
    });

    const { container } = render(
      <LiveblocksDsComment comment={makeComment()} />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(AUTHOR_NAME, { exact: true })).toHaveLength(1);
  });
});
