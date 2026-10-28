import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";
import { renderWithNav } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-7052 Part A (tamsinb review) — the Reset view seam on the v2 surface.
 *
 * The v1 `SessionsToolbar` has offered this command since FEA-4021, through
 * `TableViewMenu`'s reset row. The v2 surface replaces that whole toolbar, so
 * until this seam existed, opening the flag left a reader who had reordered or
 * hidden columns with no one-click path back to the shipped defaults.
 *
 * Asserted at BOTH widths on purpose. The wide options menu and the folded one
 * are the same capability at two sizes, and this surface appends the item
 * through the single `trailing` slot precisely so it cannot be offered at one
 * width and missing at the other — a control that vanishes when the window
 * narrows reads as the product losing a feature.
 */

const WIDE_MENU_NAME = "Options";
const COMPACT_MENU_NAME = "View";
const RESET_ITEM_NAME = "Reset view";
// Above and below the surface's own fold threshold, so each case mounts the
// menu it names rather than whichever one jsdom's zero width would default to.
const WIDE_CONTAINER_PX = 1440;
const NARROW_CONTAINER_PX = 480;

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({
    id: "ses-1",
    name: "agent/first-row",
    status: "Active",
  }),
];

function viewWith(columnIds: readonly string[]): SessionsListViewState {
  return {
    sortBy: null,
    sortDir: "asc",
    grouping: EMPTY_TABLE_GROUPING,
    facets: DEFAULT_SESSION_FACET_FILTERS,
    dateRange: DEFAULT_DATE_RANGE,
    visibleColumnIds: new Set(columnIds),
    page: 0,
    scopeUserId: null,
  };
}

function renderSurface(
  props: Partial<React.ComponentProps<typeof SessionsListSurfaceV2>> = {}
) {
  return renderWithNav(
    <SessionsListSurfaceV2
      controlledView={{
        value: viewWith(["status"]),
        onChange: () => undefined,
      }}
      rows={ROWS}
      usage={undefined}
      {...props}
    />
  );
}

/** Radix opens on `pointerdown`, not `click`. */
function openMenu(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name }), {
    button: 0,
    ctrlKey: false,
  });
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 Reset view", () => {
  it("reports the wide menu's reset to the host", () => {
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    const onResetView = vi.fn();
    renderSurface({ onResetView });

    openMenu(WIDE_MENU_NAME);
    fireEvent.click(screen.getByRole("menuitem", { name: RESET_ITEM_NAME }));

    // The CALL, not the item's presence: an item rendered against a dropped or
    // stubbed handler is a control that does not work, and a presence-only
    // assertion cannot tell the two apart.
    expect(onResetView).toHaveBeenCalledTimes(1);
  });

  it("reports the folded menu's reset to the host", () => {
    restoreContainerWidth = stubContainerWidthPx(NARROW_CONTAINER_PX);
    const onResetView = vi.fn();
    renderSurface({ onResetView });

    openMenu(COMPACT_MENU_NAME);
    fireEvent.click(screen.getByRole("menuitem", { name: RESET_ITEM_NAME }));

    expect(onResetView).toHaveBeenCalledTimes(1);
  });

  it("offers no reset when the host has no default view to restore", () => {
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
    renderSurface();

    openMenu(WIDE_MENU_NAME);

    // A surface whose view is not persisted has nothing to reset to, and an
    // action that does nothing is worse than an absent one.
    expect(
      screen.queryByRole("menuitem", { name: RESET_ITEM_NAME })
    ).toBeNull();
  });
});
