/**
 * ISS-7441, consumer side: the Sessions Owner cell names its owner ONCE.
 *
 * `CommentAvatar` is shared, so `alt=""` changed announcement wherever it
 * mounts — and this cell is the mount furthest from the comment rail the ticket
 * cited, reached by BOTH shells (`SyncedSessionsTable` renders on web and in
 * the desktop renderer). It is safe only because `renderOwnerCell` prints the
 * owner name beside the avatar unconditionally, which is a fact about this
 * caller and therefore has to be asserted here: a later edit that drops the
 * name span would leave a nameless row and the shared suite green.
 *
 * `AvatarImage` is mocked through `@repo/app/test/mocks/avatar-image`, whose
 * docstring carries the reason and the bounds. The bound that matters here: the
 * stand-in drops every image prop but `alt` and `src`, so this file is the
 * fast, `alt`-scoped half. The load-bearing half — real Radix, a real image
 * load, and an UNFILTERED accessible-name count on this same cell — is
 * `e2e/sessions-owner-avatar-name.spec.ts`.
 */
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

import { SESSIONS_OWNER_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { renderSessionCell } from "../session-cell-renderers";
import { createSessionTableRowFixture } from "../session-list-fixtures";

const OWNER_NAME = "Dana Reed";
const OWNER_AVATAR_URL = "https://example.test/dana.png";

function renderOwnerCell(avatarUrl: string | null) {
  const row = createSessionTableRowFixture({
    user: { id: "user-dana", name: OWNER_NAME, avatarUrl },
  });
  return render(renderSessionCell(SESSIONS_OWNER_COLUMN_ID, row));
}

describe("Sessions Owner cell name announcement (ISS-7441)", () => {
  it("renders the photo, keeps it out of the accessibility tree, and names the owner once", () => {
    const { container } = renderOwnerCell(OWNER_AVATAR_URL);

    // POSITIVE CONTROL. Without it the negative below is satisfied by a cell
    // that rendered no photo at all.
    const photo = container.querySelector("img");
    expect(photo).not.toBeNull();
    expect(photo).toHaveAttribute("src", OWNER_AVATAR_URL);

    // Scoped to `alt`, and only `alt`: the stand-in above drops every other
    // image prop, so an `aria-label={author}` would leave this green (whitlockk,
    // PR #6640). The unfiltered claim against real Radix, on THIS cell, is
    // `e2e/sessions-owner-avatar-name.spec.ts`.
    expect(screen.queryAllByRole("img")).toHaveLength(0);

    // And the name survives — exactly once, never `toBeInTheDocument()`,
    // because "present" is what the defect also satisfied.
    expect(screen.getAllByText(OWNER_NAME, { exact: true })).toHaveLength(1);
  });

  it("still names a photo-less owner once, with no image involved", () => {
    const { container } = renderOwnerCell(null);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(OWNER_NAME, { exact: true })).toHaveLength(1);
  });
});
