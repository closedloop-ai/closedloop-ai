import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";
import { TEST_USER } from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-7746. `AssigneeAvatar` used to state WHO is assigned only through a hover
 * `Tooltip`, so the identity was unreachable to a screen reader, the keyboard,
 * and touch — none of which hover.
 *
 * Every assertion here goes through the accessibility tree and NOTHING hovers.
 * That is deliberate on both counts: `data-slot="avatar"` is merged away by
 * `TooltipTrigger asChild`, Radix `AvatarImage` never mounts in jsdom, and a
 * test that hovers would stay green against the exact bug the ticket describes.
 *
 * The name strings are written as literals rather than imported from
 * `UNASSIGNED_ASSIGNEE_LABEL` on purpose — this is a copy contract, and
 * re-deriving the expectation from the code under test would keep the suite
 * green when the words a screen reader speaks change.
 *
 * Scope: this file covers the avatar's OWN behavior only. The consumer-side
 * assertions — which surfaces opt out via `decorative` and which still state the
 * name — live in `documents/components/__tests__/assignee-avatar-consumers.test.tsx`,
 * because `shared/**` must never import a feature slice (`packages/app/AGENTS.md`).
 */

const ASSIGNED_NAME = "Ada Lovelace";
const UNASSIGNED_NAME = "Unassigned";

describe("AssigneeAvatar accessible name", () => {
  it("names the assignee without hover, in the default linked+tooltip shape", () => {
    render(<AssigneeAvatar assignee={TEST_USER} />);

    expect(screen.getByRole("img", { name: ASSIGNED_NAME })).toBeVisible();
    // The name is exposed only through the accessibility tree; the avatar
    // renders initials, so a visible-text query must NOT be what satisfies this.
    expect(screen.queryByText(ASSIGNED_NAME)).toBeNull();
  });

  it("names the link wrapping the avatar, which used to announce the initials", () => {
    // Before ISS-7746 this link's accessible name came from the fallback text,
    // so it announced "AL" — a name, but not the person's.
    render(<AssigneeAvatar assignee={TEST_USER} />);

    expect(screen.getByRole("link", { name: ASSIGNED_NAME })).toBeVisible();
    // One initial on every avatar (Nerys, 2026-10-22): the fallback now reads
    // "A", so that is the name the link must not take.
    expect(screen.queryByRole("link", { name: "A" })).toBeNull();
  });

  it("names the unassigned state in text, not hue alone", () => {
    render(<AssigneeAvatar assignee={null} />);

    expect(screen.getByRole("img", { name: UNASSIGNED_NAME })).toBeVisible();
    expect(screen.queryByText(UNASSIGNED_NAME)).toBeNull();
  });

  it("keeps the assignee's name when the tooltip and link are both suppressed", () => {
    // The shape three of the four consumers use: no tooltip at all, so the
    // accessible name is the ONLY statement of identity that exists.
    render(<AssigneeAvatar assignee={TEST_USER} disableLink disableTooltip />);

    expect(screen.getByRole("img", { name: ASSIGNED_NAME })).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps the unassigned name when the tooltip is suppressed", () => {
    render(<AssigneeAvatar assignee={null} disableLink disableTooltip />);

    expect(screen.getByRole("img", { name: UNASSIGNED_NAME })).toBeVisible();
  });

  it("gives the two states different accessible names in one tree", () => {
    render(
      <>
        <AssigneeAvatar assignee={TEST_USER} disableLink disableTooltip />
        <AssigneeAvatar assignee={null} disableLink disableTooltip />
      </>
    );

    const names = screen
      .getAllByRole("img")
      .map((element) => element.getAttribute("aria-label"));
    expect(names).toEqual([ASSIGNED_NAME, UNASSIGNED_NAME]);
  });

  it("removes the avatar from the accessibility tree when decorative", () => {
    // The opt-out an ancestor that already states the identical name uses. It
    // deduplicates an announcement rather than relocating one, so the avatar
    // must contribute NOTHING — not the name, and not the fallback initials.
    render(
      <AssigneeAvatar
        assignee={TEST_USER}
        decorative
        disableLink
        disableTooltip
      />
    );

    expect(screen.queryByRole("img")).toBeNull();
    // The initials stay in the DOM — `aria-hidden` prunes the accessibility
    // tree, not the markup — so the contract is that they sit INSIDE the hidden
    // subtree. Asserting their absence from the DOM would describe the wrong
    // mechanism and pass for the wrong reason.
    expect(
      screen.getByText("A").closest("[aria-hidden='true']")
    ).not.toBeNull();
  });
});
