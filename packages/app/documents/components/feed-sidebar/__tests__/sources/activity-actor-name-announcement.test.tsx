/**
 * ISS-5955: the activity row announces the actor's name once BESIDE THE PHOTO.
 *
 * Stated that narrowly on purpose. `ActivityActor` used to pass
 * `alt={displayName}` to the avatar photo while the span two nodes along
 * rendered the SAME string, so a screen reader read the person twice on every
 * human row with a photo — `img "Dana Reed"`, then link `Dana Reed`. The photo
 * now carries `alt=""` and is out of the accessibility tree entirely.
 *
 * What is NOT closed, so nobody reads this file as the whole axis: a photo-LESS
 * human row still exposes the `AvatarFallback` initials, so AT gets "D R" and
 * then the link. That is a derived abbreviation rather than the name, and
 * hiding it was the other half of ISS-6174, which was canceled. It is a ruling,
 * not an oversight — see the comment at the fallback in `activity-actor.tsx`.
 *
 * WHY THIS FILE MOCKS `AvatarImage`, stated plainly so the next reader does not
 * take it for laziness. Radix's `AvatarImage` gates its commit on a real image
 * LOAD, and jsdom never loads one — measured, not assumed: rendering this
 * component unmocked yields `container.querySelectorAll("img").length === 0`,
 * so an assertion on the alt passes vacuously in BOTH directions. The stand-in
 * and its deliberate bounds are `@repo/app/test/mocks/avatar-image`, shared with
 * the ISS-7441 suites that make the same claim about `CommentAvatar`; the real
 * `Avatar` and `AvatarFallback` come through untouched, which is why the
 * fallback still renders alongside the photo here where production would hide
 * it. Nothing below asserts on the fallback.
 *
 * `UserLink` is mocked too, as the sibling suites do, so the name resolves
 * without a router. It renders a `<span>` rather than the real anchor, so
 * nothing here may assert on the name's ROLE — only on its text, and on the
 * image's absence from the accessibility tree. The role-level claim belongs to
 * the e2e spec, which drives the real link.
 *
 * The same claim against the REAL Radix component in a REAL browser is
 * `e2e/document-activity-actor-kind.spec.ts`. This file is the fast, runnable
 * half; that one is the load-bearing half.
 *
 * WHICH assertion is the regression detector: the FIRST TEST'S, and only it.
 * Measured, not reasoned — reverting the component to `alt={displayName}` and
 * re-running this file yields `1 failed | 3 passed`, the failure being
 * `queryAllByRole("img")`. The other three cannot go red on that mutation and
 * nothing here claims they can: the name-count test reads text nodes, which an
 * `alt` never populates, and the last two render no `<img>` at all.
 *
 * They earn their lines on a different axis, not as counterfactual coverage of
 * the alt (whitlockk, PR #5531). The name-count test is the guard against
 * OVER-correcting — deleting a redundant announcement must not delete the last
 * one — and the final two pin the photo-less human and non-human branches,
 * where this change had to be a no-op. The first test's own vacuity control is
 * INSIDE it, the `photo` assertion; it is not delegated to its neighbours.
 */
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

import { ActivityActor } from "../../sources/activity-actor";
import {
  AGENT_ACTOR,
  DANA,
  DANA_AVATAR_URL,
  DANA_NAME,
  DANA_WITH_PHOTO,
  HUMAN_ACTOR,
  readyDirectory,
} from "./activity-actor-fixtures";

describe("ActivityActor name announcement (ISS-5955)", () => {
  it("renders the photo but gives it no accessible name", () => {
    const { container } = render(
      <ActivityActor
        actor={HUMAN_ACTOR}
        directory={readyDirectory(DANA_WITH_PHOTO)}
      />
    );

    // POSITIVE CONTROL. Without this the assertions below are satisfied by a
    // row that rendered no photo at all, which is the failure mode a negative
    // a11y assertion is most exposed to.
    const photo = container.querySelector("img");
    expect(photo).not.toBeNull();
    expect(photo).toHaveAttribute("src", DANA_AVATAR_URL);

    // An `alt=""` image maps to `presentation`, so it is not an `img` in the
    // accessibility tree at all. What this pins is the change itself: revert
    // the component to `alt={displayName}` and the role comes back.
    //
    // What it does NOT pin, stated plainly so nobody reads more into it. The
    // `AvatarImage` stand-in above forwards only `alt` and `src` — no rest
    // spread — so an `aria-label` added to the real component never reaches
    // this DOM. Measured, not reasoned: adding `aria-label={displayName}`
    // beside `alt=""` leaves this file GREEN (whitlockk, PR #5531). That variant is
    // covered against real Radix in a real browser by
    // `e2e/document-activity-actor-kind.spec.ts:295`, whose unfiltered
    // `getByRole("img")` count catches an accessible name however it is
    // spelled. The contract is covered system-wide; this half is just not where.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryByRole("img", { name: DANA_NAME })).toBeNull();
  });

  it("still announces the name exactly once beside the photo", () => {
    render(
      <ActivityActor
        actor={HUMAN_ACTOR}
        directory={readyDirectory(DANA_WITH_PHOTO)}
      />
    );

    // De-duplicating must not delete the only accessible statement. Exactly
    // one — `toHaveLength(1)`, never `toBeInTheDocument()`, because "present"
    // is what the defect also satisfied.
    expect(screen.getAllByText(DANA_NAME, { exact: true })).toHaveLength(1);
  });

  it("names a photo-less human row from the text, with no image involved", () => {
    const { container } = render(
      <ActivityActor actor={HUMAN_ACTOR} directory={readyDirectory(DANA)} />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(DANA_NAME, { exact: true })).toHaveLength(1);
  });

  it("leaves a non-human row, which never has a photo, unchanged", () => {
    const { container } = render(
      <ActivityActor actor={AGENT_ACTOR} directory={readyDirectory(DANA)} />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText("Agent", { exact: true })).toHaveLength(1);
  });
});
