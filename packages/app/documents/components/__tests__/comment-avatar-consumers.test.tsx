/**
 * ISS-7441, consumer side: the artifact comment rail names each author ONCE.
 *
 * `CommentAvatar` is shared, so `alt=""` changed announcement everywhere it
 * mounts, not just on the feed rail the ticket cited. That is safe only because
 * every consumer states the author itself, unconditionally — and "safe because
 * of a fact about the caller" is a fact that has to be asserted at the caller,
 * or the next edit to this file deletes the only accessible name and the shared
 * suite stays green.
 *
 * Both mounts are covered because they are separate call sites with separate
 * name slots: the root comment's `CommentThreadHeader` and each reply's own.
 *
 * `AvatarImage` is mocked through `@repo/app/test/mocks/avatar-image`, whose
 * docstring carries the reason and the bounds.
 *
 * The sibling consumer in this slice, `RelatedSessionsCell`, is unaffected: it
 * wraps the whole avatar in `aria-hidden` and names the owner in an `sr-only`
 * sentence, already asserted by `related-sessions-field.test.tsx` ("names the
 * owner in the accessible sentence").
 */
import { ThreadStatus } from "@repo/api/src/types/comment";
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The shared MentionComposer reads org members for its typeahead.
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: { id: "user-you" } }),
  useOrganizationUsers: () => ({ data: [] }),
}));

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

import {
  CommentsSectionView,
  type CommentThreadItem,
} from "../comments-section";

const ROOT_AUTHOR_NAME = "Avery Carter";
const ROOT_AUTHOR_AVATAR_URL = "https://example.test/avery.png";
const REPLY_AUTHOR_NAME = "Dana Reed";
const REPLY_AUTHOR_AVATAR_URL = "https://example.test/dana.png";

const THREAD: CommentThreadItem = {
  id: "thread-1",
  authorId: "user-avery",
  status: ThreadStatus.Open,
  resolvedByName: null,
  participantIds: ["user-avery", "user-dana"],
  author: { name: ROOT_AUTHOR_NAME, avatarUrl: ROOT_AUTHOR_AVATAR_URL },
  body: "The rollout needs a fallback plan.",
  createdAt: "2026-05-29T13:45:00.000Z",
  replies: [
    {
      id: "reply-1",
      authorId: "user-dana",
      author: { name: REPLY_AUTHOR_NAME, avatarUrl: REPLY_AUTHOR_AVATAR_URL },
      body: "Agreed — I'll draft one.",
      createdAt: "2026-05-29T14:05:00.000Z",
    },
  ],
};

function renderRail() {
  return render(
    <CommentsSectionView
      comments={[THREAD]}
      onOpenChange={() => undefined}
      onSubmitComment={() => undefined}
      open
    />
  );
}

describe("Artifact comment rail author announcement (ISS-7441)", () => {
  it("renders both photos and exposes neither to the accessibility tree", () => {
    const { container } = renderRail();

    // POSITIVE CONTROL. Both avatars must really have rendered, or the
    // negative below is satisfied by a rail that drew no photo at all.
    const sources = Array.from(container.querySelectorAll("img")).map((image) =>
      image.getAttribute("src")
    );
    expect(sources).toEqual([ROOT_AUTHOR_AVATAR_URL, REPLY_AUTHOR_AVATAR_URL]);

    // Scoped to `alt`, and only `alt`: the stand-in above drops every other
    // image prop, so an `aria-label={author}` would leave this green (whitlockk,
    // PR #6640). The unfiltered claim against real Radix is
    // `e2e/sessions-owner-avatar-name.spec.ts`.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("still announces the root author and the replier exactly once each", () => {
    renderRail();

    // De-duplicating must not delete the last statement. Exactly one each —
    // `toHaveLength(1)`, never `toBeInTheDocument()`, because "present" is what
    // the defect also satisfied.
    expect(screen.getAllByText(ROOT_AUTHOR_NAME, { exact: true })).toHaveLength(
      1
    );
    expect(
      screen.getAllByText(REPLY_AUTHOR_NAME, { exact: true })
    ).toHaveLength(1);
  });
});
