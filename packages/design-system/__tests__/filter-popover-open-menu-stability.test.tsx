import { FilterPopover } from "@closedloop-ai/design-system/components/ui/filter-popover";
import { FilterPopover as FilterPopoverV2 } from "@closedloop-ai/design-system/components/ui/filter-popover-v2";
import { RangeSubmenu } from "@closedloop-ai/design-system/components/ui/filter-range-submenu-v2";
import { STATUS_LABELS } from "@closedloop-ai/design-system/components/ui/status-icon";
import type {
  FilterMenuGroup,
  TableFilterOption,
  TableFiltersController,
  TableFiltersViewModel,
} from "@closedloop-ai/design-system/components/ui/table-filters";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  builtInViewModel,
  facetViewModel,
  NOOP_CONTROLLER,
  openFacet,
  openFilterMenu,
  repositoryFacet,
} from "./fixtures/filter-popover-fixtures";

/**
 * ISS-7120. A facet submenu is portalled, and its rows are keyed by option id,
 * so React removes a row the instant its option leaves the live list. Whatever
 * narrows that list — a refetch, an invalidation, a boot import still writing
 * rows — the row under the pointer detaches mid-interaction and the click lands
 * on nothing. Playwright reports it as `element was detached from the DOM`; a
 * person reports nothing and clicks again.
 */

const EXTRA_OPTION_NAME = /^cohort-extra/;
const CORE_OPTION_NAME = /^cohort-core/;
const LATE_OPTION_NAME = /^cohort-late/;
const CANONICAL_OPTION_NAME = /^Canonical open/;

const CORE_OPTION: TableFilterOption = {
  id: "acme/cohort-core",
  label: "cohort-core",
  count: 100,
};
const EXTRA_OPTION: TableFilterOption = {
  id: "acme/cohort-extra",
  label: "cohort-extra",
  count: 1,
};
const LATE_OPTION: TableFilterOption = {
  id: "acme/cohort-late",
  label: "cohort-late",
  count: 3,
};
const CONTENT_OPTION: TableFilterOption = {
  id: "canonical-open",
  label: "Legacy open",
  content: <span>Canonical open</span>,
  count: 2,
};

/** The same option, after the boot import has finished counting its rows. */
const BUSIER_EXTRA_OPTION: TableFilterOption = { ...EXTRA_OPTION, count: 7 };

/** What the Repository facet says when it genuinely has nothing to offer. */
const EMPTY_FACET_LABEL = "No repositories to filter by";

const CORE_MEMBER: TableFilterOption = {
  id: "member-core",
  label: "member-core",
  count: 4,
};
const EXTRA_MEMBER: TableFilterOption = {
  id: "member-extra",
  label: "member-extra",
  count: 2,
};
const MEMBER_NAME = /^member-extra/;
const OWNER_FACET_NAME = /^Owner/;

describe("FilterPopover range-submenu adapter", () => {
  it("preserves a host's scoped range Escape without changing other menus", async () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        renderRangeSubmenu={(group, clearLabel) => (
          <RangeSubmenu clearLabel={clearLabel} group={group} />
        )}
        viewModel={builtInViewModel({
          facetGroups: [
            { id: "cost", kind: "range", label: "Cost", onChange: vi.fn() },
          ],
        })}
      />
    );

    openFacet("Cost");
    expect(await screen.findByLabelText("Min")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("Min"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByLabelText("Min")).toBeNull());
    const trigger = screen.getByRole("menuitem", { name: "Cost" });
    expect(trigger).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });
});

const CORE_TAG: TableFilterOption = {
  id: "tag-core",
  label: "tag-core",
  count: 4,
};
const EXTRA_TAG: TableFilterOption = {
  id: "tag-extra",
  label: "tag-extra",
  count: 2,
};
const TAG_NAME = /^tag-extra/;

function popover(
  options: TableFilterOption[],
  onToggle: (value: string) => void,
  emptyLabel?: string
) {
  return (
    <FilterPopover
      controller={NOOP_CONTROLLER}
      viewModel={facetViewModel(options, onToggle, emptyLabel)}
    />
  );
}

/** The Grid Table v2 promotion candidate, which carries the same menu. */
function popoverV2(
  options: TableFilterOption[],
  onToggle: (value: string) => void,
  emptyLabel?: string
) {
  return (
    <FilterPopoverV2
      controller={NOOP_CONTROLLER}
      viewModel={facetViewModel(options, onToggle, emptyLabel)}
    />
  );
}

/**
 * The built-in menu — no `facetGroups`, so the Assignee and Tags submenus render
 * instead of the generic facet list. Those two are fed from the same churning
 * query data as the facets and hold their rows the same way.
 */
function builtInPopover(
  viewModel: Partial<TableFiltersViewModel>,
  controller: TableFiltersController
) {
  return (
    <FilterPopover
      controller={controller}
      viewModel={builtInViewModel(viewModel)}
    />
  );
}

function builtInPopoverV2(
  viewModel: Partial<TableFiltersViewModel>,
  controller: TableFiltersController
) {
  return (
    <FilterPopoverV2
      controller={controller}
      viewModel={builtInViewModel(viewModel)}
    />
  );
}

/** Open the Filter menu, then its Repository submenu. */
function openRepositoryFacet(): void {
  openFacet("Repository");
}

/** The text a held row is actually showing — `label` immediately followed by `count`. */
function rowText(name: RegExp): string {
  return screen.getByRole("menuitem", { name }).textContent ?? "";
}

/** Dismiss the whole menu from the facet submenu, the innermost open one. */
function closeOpenFacet(): void {
  const menus = screen.getAllByRole("menu");
  const submenu = menus.at(-1);
  if (!submenu) {
    throw new Error("No open menu to close");
  }
  fireEvent.keyDown(submenu, { key: "Escape" });
}

describe("FilterPopover option stability while a facet submenu is open", () => {
  it.each([
    ["v1", popover],
    ["v2", popoverV2],
  ])(
    "renders an option's atomic content branch in %s",
    (_name, renderPopover) => {
      render(renderPopover([CONTENT_OPTION], vi.fn()));
      openRepositoryFacet();

      expect(
        screen.getByRole("menuitem", { name: CANONICAL_OPTION_NAME })
      ).toBeInTheDocument();
      expect(screen.queryByText(CONTENT_OPTION.label)).not.toBeInTheDocument();
    }
  );

  it("keeps a rendered option clickable after the live list drops it", {
    timeout: 30_000,
  }, () => {
    const onToggle = vi.fn();
    const { rerender } = render(popover([CORE_OPTION, EXTRA_OPTION], onToggle));
    openRepositoryFacet();
    const option = screen.getByRole("menuitem", { name: EXTRA_OPTION_NAME });

    rerender(popover([CORE_OPTION], onToggle));

    expect(option.isConnected).toBe(true);
    expect(screen.getByRole("menuitem", { name: EXTRA_OPTION_NAME })).toBe(
      option
    );
    fireEvent.click(option);
    expect(onToggle).toHaveBeenCalledWith(EXTRA_OPTION.id);
  });

  it("appends an option that arrives mid-open instead of reordering the rows", {
    timeout: 30_000,
  }, () => {
    const onToggle = vi.fn();
    const { rerender } = render(popover([CORE_OPTION, EXTRA_OPTION], onToggle));
    openRepositoryFacet();

    rerender(popover([LATE_OPTION, CORE_OPTION, EXTRA_OPTION], onToggle));

    const names = screen
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(names.filter((name) => CORE_OPTION_NAME.test(name))).toHaveLength(1);
    expect(
      names.indexOf(names.find((n) => LATE_OPTION_NAME.test(n)) ?? "")
    ).toBe(names.length - 1);
  });

  it("keeps an option that arrived mid-open and then left", {
    timeout: 30_000,
  }, () => {
    const onToggle = vi.fn();
    const { rerender } = render(popover([CORE_OPTION], onToggle));
    openRepositoryFacet();

    rerender(popover([CORE_OPTION, LATE_OPTION], onToggle));
    const late = screen.getByRole("menuitem", { name: LATE_OPTION_NAME });
    rerender(popover([CORE_OPTION], onToggle));

    expect(late.isConnected).toBe(true);
    fireEvent.click(late);
    expect(onToggle).toHaveBeenCalledWith(LATE_OPTION.id);
  });

  it("holds the same rows in the v2 promotion candidate", {
    timeout: 30_000,
  }, () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      popoverV2([CORE_OPTION, EXTRA_OPTION], onToggle)
    );
    openRepositoryFacet();
    const option = screen.getByRole("menuitem", { name: EXTRA_OPTION_NAME });

    rerender(popoverV2([CORE_OPTION], onToggle));

    expect(option.isConnected).toBe(true);
    fireEvent.click(option);
    expect(onToggle).toHaveBeenCalledWith(EXTRA_OPTION.id);
  });

  it("re-reads the live list on the next open", { timeout: 30_000 }, () => {
    const onToggle = vi.fn();
    const { rerender } = render(popover([CORE_OPTION, EXTRA_OPTION], onToggle));
    openRepositoryFacet();
    rerender(popover([CORE_OPTION], onToggle));
    closeOpenFacet();

    openRepositoryFacet();

    expect(
      screen.queryByRole("menuitem", { name: EXTRA_OPTION_NAME })
    ).toBeNull();
  });

  // The other half of the hold, and the half nothing else in this file pins: a
  // held row is held in PLACE, not frozen. While its option is still in the live
  // list the row must re-read that option every render, or the hold silently
  // becomes a snapshot and the menu shows counts the data moved past.
  it("refreshes a held row from the live list while its option is present", {
    timeout: 30_000,
  }, () => {
    const onToggle = vi.fn();
    const { rerender } = render(popover([CORE_OPTION, EXTRA_OPTION], onToggle));
    openRepositoryFacet();
    const row = screen.getByRole("menuitem", { name: EXTRA_OPTION_NAME });
    expect(rowText(EXTRA_OPTION_NAME)).toBe("cohort-extra1");

    rerender(popover([CORE_OPTION, BUSIER_EXTRA_OPTION], onToggle));

    expect(rowText(EXTRA_OPTION_NAME)).toBe("cohort-extra7");
    expect(screen.getByRole("menuitem", { name: EXTRA_OPTION_NAME })).toBe(row);
  });

  // And once the option does leave, the values it leaves behind are the ones the
  // user last saw — not the ones it happened to carry when the menu opened. A
  // count sliding BACKWARD from 7 to 1 is the menu lying about data it already
  // rendered correctly.
  it("falls back to a held row's last-seen values, not its first-seen ones", {
    timeout: 30_000,
  }, () => {
    const onToggle = vi.fn();
    const { rerender } = render(popover([CORE_OPTION, EXTRA_OPTION], onToggle));
    openRepositoryFacet();
    rerender(popover([CORE_OPTION, BUSIER_EXTRA_OPTION], onToggle));

    rerender(popover([CORE_OPTION], onToggle));

    expect(rowText(EXTRA_OPTION_NAME)).toBe("cohort-extra7");
  });
});

/**
 * The hold remembers every option the menu has shown, so it can never itself
 * report a facet as empty. A facet that genuinely runs out of options while the
 * menu is open has to say so — stale rows for repositories that no longer exist
 * are a menu lying about its own state, and they are clickable.
 */
/**
 * ISS-7120 second half. Holding the ROWS is not enough when the whole SUBMENU
 * can go: the menu is anchored to a button in the page, so any layout change
 * above that button — the desktop first-launch import splash animating its own
 * height is the one that ships — slides the open menu under a cursor that never
 * moved. Radix reads the resulting pointer leave as the person leaving the
 * sub-trigger, focuses the parent menu container, and closes the submenu, which
 * detaches every row in it mid-click.
 */
describe("FilterPopover submenu survival when the menu moves under the pointer", () => {
  it("keeps the facet submenu open when Radix bounces focus to the parent menu", {
    timeout: 30_000,
  }, () => {
    render(popover([CORE_OPTION, EXTRA_OPTION], vi.fn()));
    openRepositoryFacet();
    const row = screen.getByRole("menuitem", { name: CORE_OPTION_NAME });

    leaveSubTriggerWithoutMovingOn("Repository");

    expect(row.isConnected).toBe(true);
  });

  it("keeps the submenu open in the v2 promotion candidate", {
    timeout: 30_000,
  }, () => {
    render(popoverV2([CORE_OPTION, EXTRA_OPTION], vi.fn()));
    openRepositoryFacet();
    const row = screen.getByRole("menuitem", { name: CORE_OPTION_NAME });

    leaveSubTriggerWithoutMovingOn("Repository");

    expect(row.isConnected).toBe(true);
  });

  /**
   * The other half of the contract, so the guard above cannot widen into "a
   * submenu never closes": moving onto a DIFFERENT facet focuses that facet's
   * row, which is a menu item and not the container, and still closes the one
   * that was open.
   */
  it("still closes the submenu when the pointer moves to another facet", {
    timeout: 30_000,
  }, () => {
    render(
      <FilterPopover
        controller={NOOP_CONTROLLER}
        viewModel={{
          teamMembers: [],
          statusOptions: [],
          priorityOptions: [],
          hideQuickToggles: true,
          facetGroups: [
            repositoryFacet([CORE_OPTION, EXTRA_OPTION], vi.fn()),
            OTHER_FACET,
          ],
        }}
      />
    );
    openRepositoryFacet();
    const row = screen.getByRole("menuitem", { name: CORE_OPTION_NAME });

    fireEvent.pointerMove(
      screen.getByRole("menuitem", { name: OWNER_FACET_NAME }),
      {
        pointerType: "mouse",
      }
    );

    expect(row.isConnected).toBe(false);
  });
});

describe("FilterPopover empty facet while a submenu is open", () => {
  // Positive control for the two absence assertions below: this is the selector
  // they use, matching in the case where the row is supposed to be there.
  it("renders the empty row for a facet with no options", {
    timeout: 30_000,
  }, () => {
    render(popover([], vi.fn(), EMPTY_FACET_LABEL));

    openRepositoryFacet();

    expect(
      screen.getByRole("menuitem", { name: EMPTY_FACET_LABEL })
    ).toBeTruthy();
  });

  it("returns to the empty row when the facet empties while open", {
    timeout: 30_000,
  }, () => {
    const { rerender } = render(
      popover([CORE_OPTION, EXTRA_OPTION], vi.fn(), EMPTY_FACET_LABEL)
    );
    openRepositoryFacet();
    expect(
      screen.queryByRole("menuitem", { name: EMPTY_FACET_LABEL })
    ).toBeNull();

    rerender(popover([], vi.fn(), EMPTY_FACET_LABEL));

    expect(
      screen.getByRole("menuitem", { name: EMPTY_FACET_LABEL })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: EXTRA_OPTION_NAME })
    ).toBeNull();
  });

  it("returns to the empty row in the v2 promotion candidate", {
    timeout: 30_000,
  }, () => {
    const { rerender } = render(
      popoverV2([CORE_OPTION, EXTRA_OPTION], vi.fn(), EMPTY_FACET_LABEL)
    );
    openRepositoryFacet();
    expect(
      screen.queryByRole("menuitem", { name: EMPTY_FACET_LABEL })
    ).toBeNull();

    rerender(popoverV2([], vi.fn(), EMPTY_FACET_LABEL));

    expect(
      screen.getByRole("menuitem", { name: EMPTY_FACET_LABEL })
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: EXTRA_OPTION_NAME })
    ).toBeNull();
  });
});

/**
 * The Assignee and Tags submenus are portalled, keyed-by-id row lists fed from
 * the same churning query data as the facets, so they detach a row under the
 * pointer exactly the way the facets did.
 */
describe("FilterPopover built-in submenu stability", () => {
  it.each([
    ["v1", builtInPopover],
    ["v2", builtInPopoverV2],
  ])("names the Status submenu once in %s", (_name, renderPopover) => {
    render(renderPopover({}, NOOP_CONTROLLER));
    openFilterMenu();

    expect(
      screen.getByRole("menuitem", { name: "Status" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: STATUS_LABELS.decorative })
    ).toBeNull();
  });

  it("keeps a rendered assignee clickable after the live list drops it", {
    timeout: 30_000,
  }, () => {
    const toggleAssignee = vi.fn();
    const controller = { ...NOOP_CONTROLLER, toggleAssignee };
    const { rerender } = render(
      builtInPopover({ teamMembers: [CORE_MEMBER, EXTRA_MEMBER] }, controller)
    );
    openFacet("Assignee");
    const row = screen.getByRole("menuitem", { name: MEMBER_NAME });

    rerender(builtInPopover({ teamMembers: [CORE_MEMBER] }, controller));

    expect(row.isConnected).toBe(true);
    fireEvent.click(row);
    expect(toggleAssignee).toHaveBeenCalledWith(EXTRA_MEMBER.id);
  });

  it("keeps a rendered tag clickable after the live list drops it", {
    timeout: 30_000,
  }, () => {
    const toggleTag = vi.fn();
    const controller = { ...NOOP_CONTROLLER, toggleTag };
    const { rerender } = render(
      builtInPopover({ tagOptions: [CORE_TAG, EXTRA_TAG] }, controller)
    );
    openFacet("Tags");
    const row = screen.getByRole("menuitem", { name: TAG_NAME });

    rerender(builtInPopover({ tagOptions: [CORE_TAG] }, controller));

    expect(row.isConnected).toBe(true);
    fireEvent.click(row);
    expect(toggleTag).toHaveBeenCalledWith(EXTRA_TAG.id);
  });

  it("holds a tag row in the v2 promotion candidate", {
    timeout: 30_000,
  }, () => {
    const toggleTag = vi.fn();
    const controller = { ...NOOP_CONTROLLER, toggleTag };
    const { rerender } = render(
      builtInPopoverV2({ tagOptions: [CORE_TAG, EXTRA_TAG] }, controller)
    );
    openFacet("Tags");
    const row = screen.getByRole("menuitem", { name: TAG_NAME });

    rerender(builtInPopoverV2({ tagOptions: [CORE_TAG] }, controller));

    expect(row.isConnected).toBe(true);
    fireEvent.click(row);
    expect(toggleTag).toHaveBeenCalledWith(EXTRA_TAG.id);
  });

  it("holds an assignee row in the v2 promotion candidate", {
    timeout: 30_000,
  }, () => {
    const toggleAssignee = vi.fn();
    const controller = { ...NOOP_CONTROLLER, toggleAssignee };
    const { rerender } = render(
      builtInPopoverV2({ teamMembers: [CORE_MEMBER, EXTRA_MEMBER] }, controller)
    );
    openFacet("Assignee");
    const row = screen.getByRole("menuitem", { name: MEMBER_NAME });

    rerender(builtInPopoverV2({ teamMembers: [CORE_MEMBER] }, controller));

    expect(row.isConnected).toBe(true);
    fireEvent.click(row);
    expect(toggleAssignee).toHaveBeenCalledWith(EXTRA_MEMBER.id);
  });
});

/**
 * The pointer never moved — the menu did. Chromium re-fires the boundary events
 * at the unchanged cursor position for every frame that the anchored menu
 * slides, and this is the one Radix acts on.
 */
function leaveSubTriggerWithoutMovingOn(name: string | RegExp): void {
  fireEvent.pointerLeave(screen.getByRole("menuitem", { name }), {
    pointerType: "mouse",
  });
}

/** A second facet, so moving to another facet has somewhere to go. */
const OTHER_FACET: FilterMenuGroup = {
  id: "owner",
  label: "Owner",
  options: [CORE_MEMBER],
  selectedValues: [],
  onToggle: () => undefined,
};
