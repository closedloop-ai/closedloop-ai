/**
 * ISS-7441: `CommentAvatar`'s photo carries no accessible name.
 *
 * It used to pass `alt={author}` while every consumer rendered that same string
 * as visible text beside it, so a screen reader read the person twice on every
 * comment row with a photo. ISS-5955 had already settled the identical defect
 * for `ActivityActor` one component over in the same feed rail, which left that
 * rail announcing a person once on an activity row and twice on a comment row.
 *
 * `AvatarImage` is mocked because Radix gates its commit on a real image LOAD
 * and jsdom never supplies one, so unmocked this component renders zero `<img>`
 * and an assertion on the alt passes vacuously in BOTH directions. The mechanism
 * and its deliberate bounds live in `@repo/app/test/mocks/avatar-image`; the
 * bound that matters here is that the stand-in drops every prop but `alt` and
 * `src`, so every claim below is scoped to `alt` and nothing broader. The
 * unfiltered claim — no accessible name however spelled — belongs to
 * `e2e/sessions-owner-avatar-name.spec.ts`, driving real Radix.
 *
 * WHICH assertion is the regression detector: the first test's, and only it.
 * Restore `alt={author}` and this file yields `1 failed | 2 passed`, the failure
 * being `queryAllByRole("img")`. The other two cannot go red on that mutation
 * and nothing here claims they can — they pin the two branches where the change
 * had to be a no-op, and the first test carries its own vacuity control inline
 * (the `src` assertion), not delegated to its neighbours.
 *
 * Scope: the component's OWN contribution. That the callers still state the name
 * — the half that stops this from being an over-correction — is asserted at each
 * consumer, because `shared/**` may not import a feature slice
 * (`packages/app/AGENTS.md`).
 */
import { PrCommentAuthorKind } from "@repo/api/src/types/branch-view";
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

import { CommentAvatar } from "../comment-avatar";

const AUTHOR_NAME = "Dana Reed";
// One initial on every avatar (Nerys, 2026-10-22).
const AUTHOR_INITIALS = "D";
const AUTHOR_AVATAR_URL = "https://example.test/dana.png";

describe("CommentAvatar name announcement (ISS-7441)", () => {
  it("renders the photo but gives it no accessible name", () => {
    const { container } = render(
      <CommentAvatar author={AUTHOR_NAME} authorAvatar={AUTHOR_AVATAR_URL} />
    );

    // POSITIVE CONTROL. Without it the negatives below are satisfied by an
    // avatar that never rendered — the failure mode a negative accessibility
    // assertion is most exposed to.
    const photo = container.querySelector("img");
    expect(photo).not.toBeNull();
    expect(photo).toHaveAttribute("src", AUTHOR_AVATAR_URL);

    // `alt=""` maps to `presentation`, so the photo is not an `img` in the
    // accessibility tree at all. What this pins is the change itself: restore
    // `alt={author}` and the role comes back.
    //
    // What it does NOT pin, stated plainly so nobody reads more into it. The
    // `AvatarImage` stand-in forwards only `alt` and `src` — no rest spread —
    // so an `aria-label` added to the real component never reaches this DOM,
    // and this assertion stays green under that spelling (whitlockk, PR #6640).
    // The claim scoped to `alt` is all a jsdom suite over this mock can make;
    // the unfiltered one is `e2e/sessions-owner-avatar-name.spec.ts`, whose
    // `getByRole("img")` count runs against real Radix in a real browser.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryByRole("img", { name: AUTHOR_NAME })).toBeNull();
  });

  it("states nothing but the initials, so the caller owns the name", () => {
    render(
      <CommentAvatar author={AUTHOR_NAME} authorAvatar={AUTHOR_AVATAR_URL} />
    );

    // The contract this component now depends on: it never says who this is,
    // so mounting it where nothing else states the author deletes the identity
    // rather than de-duplicating it. The initials stay — a derived
    // abbreviation is not the name, and hiding it was the other half of
    // ISS-6174, which was canceled.
    expect(screen.queryByText(AUTHOR_NAME)).toBeNull();
    expect(screen.getByText(AUTHOR_INITIALS)).toBeInTheDocument();
  });

  it("leaves the bot branch, which has always been silent, unchanged", () => {
    const { container } = render(
      <CommentAvatar
        author={AUTHOR_NAME}
        authorAvatar={AUTHOR_AVATAR_URL}
        authorKind={PrCommentAuthorKind.Bot}
      />
    );

    // The glyph branch renders no photo at all and its icon is `aria-hidden`,
    // which is what the human branch now matches.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryByText(AUTHOR_NAME)).toBeNull();
  });
});
