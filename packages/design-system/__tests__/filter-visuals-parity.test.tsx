import { FilterPopover } from "@closedloop-ai/design-system/components/ui/filter-popover";
import { FilterPopover as FilterPopoverV2 } from "@closedloop-ai/design-system/components/ui/filter-popover-v2";
import type { TableFilterOption } from "@closedloop-ai/design-system/components/ui/table-filters";
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  builtInViewModel,
  facetViewModel,
  NOOP_CONTROLLER,
  openFacet,
  openFilterMenu,
} from "./fixtures/filter-popover-fixtures";

/**
 * ISS-7651. `FilterPopover` used to declare its own `OptionLeadingVisual`,
 * `TagVisual`, `OptionCount` and `getInitials` alongside byte-equivalent copies
 * in `internal/filter-visuals`, which the v2 popover already imported. These
 * assertions pin the shared visual markup after ISS-12919 removed option icons.
 */

const AVATAR_ROW_NAME = /^AAda Lovelace12$/;
const COUNTED_ROW_NAME = /^icon-repo3$/;
const PLAIN_ROW_NAME = /^plain-repo$/;
const TAG_ROW_NAME = /^tag-colored5$/;
const ASSIGN_TO_ME_ROW_NAME = /^AAssigned to me$/;

/** Exercises the avatar branch, and `getInitials` through the fallback. */
const AVATAR_OPTION: TableFilterOption = {
  id: "acme/avatar-repo",
  label: "Ada Lovelace",
  avatarUrl: "https://example.test/ada.png",
  count: 12,
};

/** A counted option with no avatar: label and count only. */
const COUNTED_OPTION: TableFilterOption = {
  id: "acme/icon-repo",
  label: "icon-repo",
  count: 3,
};

/** Neither branch, and no count: both visuals must render nothing at all. */
const PLAIN_OPTION: TableFilterOption = {
  id: "acme/plain-repo",
  label: "plain-repo",
};

/** Exercises `TagVisual`, which only the built-in Tags submenu renders. */
const COLOR_TAG: TableFilterOption = {
  id: "tag-colored",
  label: "tag-colored",
  color: "#ff8800",
  count: 5,
};

const FACET_OPTIONS = [AVATAR_OPTION, COUNTED_OPTION, PLAIN_OPTION];

/** The assigned-to-me row is the one v1 call site that reaches `getInitials` directly. */
const CURRENT_USER = { id: "user-ada", name: "Ada Lovelace" };

describe("shared filter visuals render the champion option contract", () => {
  it("draws the avatar fallback and count for an option with an avatar", () => {
    renderFacetMenu(FilterPopover);

    expect(rowVisualMarkup(AVATAR_ROW_NAME)).toBe(AVATAR_ROW_MARKUP);
  });

  it("draws the label and count for an option without an avatar", () => {
    renderFacetMenu(FilterPopover);

    expect(rowVisualMarkup(COUNTED_ROW_NAME)).toBe(COUNTED_ROW_MARKUP);
  });

  it("draws no leading visual and no count for a bare option", () => {
    renderFacetMenu(FilterPopover);

    expect(rowVisualMarkup(PLAIN_ROW_NAME)).toBe(PLAIN_ROW_MARKUP);
  });

  it("draws the tag dot and count for a coloured tag", () => {
    renderTagMenu(FilterPopover);

    expect(rowVisualMarkup(TAG_ROW_NAME)).toBe(TAG_ROW_MARKUP);
  });

  // The three rows above reach `getInitials` only through `OptionLeadingVisual`.
  // The assigned-to-me row calls it directly, so it is the call site that would
  // survive a wrong import while every other assertion here stayed green.
  it("initials the current user on the assigned-to-me row", () => {
    renderQuickToggles(FilterPopover);

    // One initial on every avatar (Nerys, 2026-10-22).
    expect(assignToMeAvatarText()).toBe("A");
  });
});

/**
 * The other half, and the half that keeps the two generations from drifting
 * apart again: v1 and v2 now read the same module, so the same option must
 * produce the same markup in both. A copy reintroduced in either file fails
 * here even if it is only a class apart.
 */
describe("FilterPopover v1 and v2 draw identical filter visuals", () => {
  it.each([
    ["an avatar option", AVATAR_ROW_NAME],
    ["a counted option", COUNTED_ROW_NAME],
    ["a bare option", PLAIN_ROW_NAME],
  ])("matches for %s", (_label, rowName) => {
    renderFacetMenu(FilterPopover);
    const v1Markup = rowVisualMarkup(rowName);
    cleanup();
    renderFacetMenu(FilterPopoverV2);

    expect(rowVisualMarkup(rowName)).toBe(v1Markup);
  });

  it("matches for a coloured tag", () => {
    renderTagMenu(FilterPopover);
    const v1Markup = rowVisualMarkup(TAG_ROW_NAME);
    cleanup();
    renderTagMenu(FilterPopoverV2);

    expect(rowVisualMarkup(TAG_ROW_NAME)).toBe(v1Markup);
  });

  it("matches for the assigned-to-me row's initials", () => {
    renderQuickToggles(FilterPopover);
    const v1Avatar = assignToMeAvatarMarkup();
    cleanup();
    renderQuickToggles(FilterPopoverV2);

    expect(assignToMeAvatarMarkup()).toBe(v1Avatar);
  });
});

const AVATAR_ROW_MARKUP =
  '<span data-slot="avatar" class="group/avatar relative flex shrink-0 rounded-full size-5"><span data-slot="avatar-fallback" class="flex size-full items-center justify-center overflow-hidden rounded-[inherit] bg-avatar-placeholder font-medium text-avatar-placeholder-foreground group-data-[size=2xs]/avatar:text-[10px] group-data-[size=xs]/avatar:text-[12px] group-data-[size=sm]/avatar:text-[14px] group-data-[size=md]/avatar:text-[16px] group-data-[size=lg]/avatar:text-[18px] group-data-[size=xl]/avatar:text-[20px] group-data-[size=2xl]/avatar:text-[24px] text-[10px]"><span class="block [text-box:trim-both_cap_alphabetic]">A</span></span></span><span class="min-w-0 flex-1 truncate">Ada Lovelace</span><span class="text-muted-foreground text-xs">12</span>';

const COUNTED_ROW_MARKUP =
  '<span class="min-w-0 flex-1 truncate">icon-repo</span><span class="text-muted-foreground text-xs">3</span>';

const PLAIN_ROW_MARKUP =
  '<span class="min-w-0 flex-1 truncate">plain-repo</span>';

const TAG_ROW_MARKUP =
  '<div class="inline-flex min-w-0 items-center gap-2"><span aria-hidden="true" class="size-2.5 shrink-0 rounded-full border" style="background-color: rgb(255, 136, 0); border-color: rgb(255, 136, 0);"></span></div><span class="min-w-0 flex-1 truncate">tag-colored</span><span class="text-muted-foreground text-xs">5</span>';

function renderFacetMenu(Popover: typeof FilterPopover): void {
  render(
    <Popover
      controller={NOOP_CONTROLLER}
      viewModel={facetViewModel(FACET_OPTIONS, () => undefined)}
    />
  );
  openFacet("Repository");
}

function renderTagMenu(Popover: typeof FilterPopover): void {
  render(
    <Popover
      controller={NOOP_CONTROLLER}
      viewModel={builtInViewModel({ tagOptions: [COLOR_TAG] })}
    />
  );
  openFacet("Tags");
}

/**
 * Everything a filter row draws except its checkbox — exactly the markup the
 * four shared visuals own. Read verbatim so a one-class difference fails.
 */
function rowVisualMarkup(name: RegExp): string {
  const row = screen.getByRole("menuitem", { name });
  return Array.from(row.children)
    .filter((child) => child.getAttribute("data-slot") !== "checkbox")
    .map((child) => child.outerHTML)
    .join("");
}

function renderQuickToggles(Popover: typeof FilterPopover): void {
  render(
    <Popover
      controller={NOOP_CONTROLLER}
      viewModel={builtInViewModel({
        currentUser: CURRENT_USER,
        hideQuickToggles: false,
      })}
    />
  );
  openFilterMenu();
}

function assignToMeAvatarMarkup(): string {
  const avatar = screen
    .getByRole("menuitem", { name: ASSIGN_TO_ME_ROW_NAME })
    .querySelector('[data-slot="avatar"]');
  if (!avatar) {
    throw new Error("The assigned-to-me row rendered no avatar");
  }
  return avatar.outerHTML;
}

function assignToMeAvatarText(): string {
  return assignToMeAvatarMarkup().replace(/<[^>]*>/g, "");
}
