import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { RangeSubmenu as ChampionRangeSubmenu } from "@closedloop-ai/design-system/components/ui/filter-range-submenu";
import { RangeSubmenu as ForkRangeSubmenu } from "@closedloop-ai/design-system/components/ui/filter-range-submenu-v2";
import {
  GridTableV2,
  type GridTableV2Column,
} from "@closedloop-ai/design-system/components/ui/grid-table-v2";
import type { FilterRangeGroup } from "@closedloop-ai/design-system/components/ui/table-filters";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * ISS-8068 — `Escape` gets you back out of a filter surface.
 *
 * Two different exits, and they are not the same behavior. Dismissing the
 * column filter popover means dismissing the menu that contains it. Dismissing
 * the range submenu means dismissing THAT submenu and nothing else, because a
 * user who opened one facet inside an otherwise-configured filter menu should
 * not lose the menu to leave the facet — and, unlike every other row in that
 * menu, the range facet's two text inputs legitimately consume
 * `ArrowLeft`/`ArrowRight` for caret movement, so Radix's own sub-close key
 * never reaches it and `Escape` is the only way out.
 */

type Row = { id: string; name: string; owner: string };

const ROWS: Row[] = [{ id: "r1", name: "Alpha", owner: "ana" }];
const COLUMNS: GridTableV2Column[] = [
  { id: "owner", label: "Owner", filterable: true },
];

/** The row the header menu renders for a filterable column. */
const FILTER_ITEM_NAME = /^Filter$/;

const COLUMN_FILTER_OPTION = "Only mine";
const RANGE_FACET_LABEL = "Cost";

function rangeGroup(
  overrides: Partial<FilterRangeGroup> = {}
): FilterRangeGroup {
  return {
    kind: "range",
    id: "cost",
    label: RANGE_FACET_LABEL,
    onChange: vi.fn(),
    ...overrides,
  };
}

function renderInOpenMenu(ui: ReactNode) {
  return render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Filter</DropdownMenuTrigger>
      <DropdownMenuContent>{ui}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Opens the range facet the way a keyboard user does, from its own row. */
async function openRangeSubmenu(): Promise<HTMLElement> {
  const trigger = screen
    .getByText(RANGE_FACET_LABEL)
    .closest("[role=menuitem]") as HTMLElement;
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByLabelText("Min");
  return trigger;
}

describe("ISS-8068 AC4 — Escape dismisses the column filter popover", () => {
  it("closes the popover opened from a column header's Filter row", async () => {
    render(
      <GridTableV2<Row>
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns="minmax(200px, 1fr) 120px"
        headerActions={{
          getFilterContent: () => <span>{COLUMN_FILTER_OPTION}</span>,
        }}
        items={ROWS}
        leadingLabel="Name"
        renderCell={(_columnId, row) => row.owner}
        renderLead={(row) => <span>{row.name}</span>}
      />
    );

    const optionsTrigger = screen.getByRole("button", {
      name: "Owner column options",
    });
    fireEvent.keyDown(optionsTrigger, { key: "Enter" });
    const filterRow = await screen.findByRole("menuitem", {
      name: FILTER_ITEM_NAME,
    });
    filterRow.focus();
    fireEvent.keyDown(filterRow, { key: "Enter" });
    // The popover is open and showing the host's filter content — established
    // before the dismissal so a "gone" assertion cannot pass on content that
    // was never there.
    expect(await screen.findByText(COLUMN_FILTER_OPTION)).toBeInTheDocument();

    fireEvent.keyDown(screen.getByText(COLUMN_FILTER_OPTION), {
      key: "Escape",
    });

    await waitFor(() =>
      expect(screen.queryByText(COLUMN_FILTER_OPTION)).toBeNull()
    );
  });
});

describe.each([
  ["champion", ChampionRangeSubmenu],
  ["flag-off fork", ForkRangeSubmenu],
])(
  "PRD-721 AC-2 / DT-FS-03 — ISS-8068 AC5 range Escape (%s)",
  (_variant, RangeSubmenu) => {
    it("closes the submenu and returns focus to the row that opened it", async () => {
      renderInOpenMenu(
        <RangeSubmenu clearLabel="Clear" group={rangeGroup()} />
      );
      const trigger = await openRangeSubmenu();

      fireEvent.keyDown(screen.getByLabelText("Min"), { key: "Escape" });

      await waitFor(() => expect(screen.queryByLabelText("Min")).toBeNull());
      // Named element, not "focus moved somewhere": Radix's untouched default
      // hands focus to the ROOT trigger, which also satisfies "focus moved".
      expect(document.activeElement).toBe(trigger);
    });

    it("leaves the parent filter menu open behind it", async () => {
      renderInOpenMenu(
        <RangeSubmenu clearLabel="Clear" group={rangeGroup()} />
      );
      await openRangeSubmenu();

      fireEvent.keyDown(screen.getByLabelText("Min"), { key: "Escape" });

      await waitFor(() => expect(screen.queryByLabelText("Min")).toBeNull());
      expect(screen.getByText(RANGE_FACET_LABEL)).toBeInTheDocument();
    });

    it("still closes the whole menu on the NEXT Escape", async () => {
      // The opposite-state sibling for the assertion above: the parent menu
      // survives because the submenu scoped the dismissal, not because the menu
      // has stopped responding to Escape at all.
      renderInOpenMenu(
        <RangeSubmenu clearLabel="Clear" group={rangeGroup()} />
      );
      const trigger = await openRangeSubmenu();

      fireEvent.keyDown(screen.getByLabelText("Min"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByLabelText("Min")).toBeNull());
      fireEvent.keyDown(trigger, { key: "Escape" });

      await waitFor(() =>
        expect(screen.queryByText(RANGE_FACET_LABEL)).toBeNull()
      );
    });

    it("keeps a committed range on the trigger after the escape", async () => {
      // Dismissal must not double as a reset: the facet the user configured is
      // still applied and still readable on the collapsed row.
      renderInOpenMenu(
        <RangeSubmenu
          clearLabel="Clear"
          group={rangeGroup({ max: 50, min: 0 })}
        />
      );
      await openRangeSubmenu();

      fireEvent.keyDown(screen.getByLabelText("Min"), { key: "Escape" });

      await waitFor(() => expect(screen.queryByLabelText("Min")).toBeNull());
      expect(screen.getByText("0 – 50")).toBeInTheDocument();
    });
  }
);
