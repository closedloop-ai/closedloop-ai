/**
 * ISS-9223 — the Sessions list keeps its identity column on screen while the
 * table scrolls horizontally, the affordance Branches has had since ISS-6959.
 *
 * WHAT LAYER THIS COVERS: the real production chain — `SessionsListGridV2`'s
 * `pinLeadColumn` → `GridTableV2` → the classes the header and body cells
 * render with. `SessionsListGridV2` is the ONE component that renders
 * `GridTableV2` for Sessions and BOTH hosts mount it, so a pin proven here is a
 * pin on web and on the desktop renderer alike; ISS-9216's "one host passes it,
 * the other does not" is not expressible from this seam.
 *
 * ISS-9659 retired the `sessions-pinned-lead-column` gate ENABLED, so the
 * flag-off arm that used to give these cases their meaning is gone with its
 * subject. What replaces it is the OFFSET half: the identity cell has to carry
 * `sticky` AND land on the utility track's own `left`, which a grid that pinned
 * nothing and a grid that pinned the wrong cell both fail.
 *
 * Both host SHAPES are driven, because they differ where the pin lives: web
 * supplies `favorites`, which puts a leading utility track at `left: 0` ahead
 * of the identity cell, and the desktop view supplies none. The primitive used
 * to decline to pin at all in the first shape — so a test that only covered the
 * desktop shape would have called a web-inert change fixed.
 *
 * WHAT IT CANNOT CATCH: jsdom performs no layout and applies no stylesheet, so
 * `position: sticky` has no observable effect here. These prove the pinning
 * classes reach the right cells, not that the cells then hold still under a
 * real scroll — the same split `branches-pinned-name-column.test.tsx` documents.
 *
 * The class names are written out as literals rather than imported from
 * `grid-table-pin.ts`, deliberately: importing them would make this test agree
 * with whatever that module currently says, including a `sticky` silently
 * dropped from it.
 */

import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import type { GridTableV2Column } from "@repo/design-system/components/ui/grid-table-v2";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListGridV2 } from "../sessions-list-grid-v2";
import { emptySessionsGridSelection } from "./sessions-selection.test-helpers";
import { renderWithFlags } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const ROW_NAME = "agent/pinned-lead";
const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({ id: "ses-1", name: ROW_NAME }),
];
const COLUMNS: readonly GridTableV2Column[] = [
  { id: "status", label: "Status" },
];

// The three declarations that together take a cell out of the horizontal
// scroll and stop the columns behind it showing through. Pinned to independent
// literals: a pin that loses its opaque surface still LOOKS pinned in a class
// list, and is unreadable on screen.
const STICKY_CLASS = "sticky";
const LEFT_EDGE_CLASS = "left-0";
const OPAQUE_SURFACE_CLASS = "bg-[var(--grid-table-surface,var(--background))]";
/**
 * Where the identity cell parks when the favourite track holds `left: 0` — the
 * 36px track this surface declares. Asserted as its own literal, and against
 * the inline `left` the primitive derives from that declared track, so a pin
 * that regressed to `left-0` behind the star (parking the name ON the favourite
 * control) cannot pass as "pinned".
 */
const UTILITY_OFFSET_PX = "36px";
/** The lead header's accessible name also carries its sort affordance. */
const LEAD_HEADER_PATTERN = /session/i;
const FAVORITE_LABEL = `Add ${ROW_NAME} to favorites`;

describe("Sessions pinned lead column (ISS-9223)", () => {
  it("pins the identity header and body cells", () => {
    renderSessionsGrid({ favorites: false });

    for (const cell of [leadHeaderCell(), leadBodyCell()]) {
      expect(cell).toHaveClass(STICKY_CLASS);
      expect(cell).toHaveClass(LEFT_EDGE_CLASS);
      expect(cell).toHaveClass(OPAQUE_SURFACE_CLASS);
    }
  });

  // The NEIGHBOUR that keeps the case above from being satisfiable by "every
  // cell is sticky": a data cell is not part of the pinned region, and a grid
  // that pinned indiscriminately would hold the whole row still under a scroll
  // and pin nothing.
  it("leaves a data cell out of the pinned region", () => {
    renderSessionsGrid({ favorites: false });

    const dataCell = closestCell(
      screen.getByText(COLUMNS[0].id),
      "status cell"
    );
    expect(dataCell).not.toHaveClass(STICKY_CLASS);
    expect(dataCell).not.toHaveClass(LEFT_EDGE_CLASS);
  });

  // The WEB host's shape. Its favourite star occupies the first track, so the
  // identity cell cannot hold `left: 0` — it parks one track in and the star
  // holds the edge. Asserted on both cells, because pinning only the identity
  // cell leaves a 36px window onto the columns scrolling behind the star.
  it("pins the favourite track and offsets the identity cell behind it", () => {
    renderSessionsGrid({ favorites: true });

    const favoriteCell = favoriteBodyCell();
    expect(favoriteCell).toHaveClass(STICKY_CLASS);
    expect(favoriteCell).toHaveClass(LEFT_EDGE_CLASS);
    expect(favoriteCell).toHaveClass(OPAQUE_SURFACE_CLASS);

    const identityCell = leadBodyCell();
    expect(identityCell).toHaveClass(STICKY_CLASS);
    expect(identityCell.style.left).toBe(UTILITY_OFFSET_PX);
    expect(identityCell).not.toHaveClass(LEFT_EDGE_CLASS);
    expect(identityCell).toHaveClass(OPAQUE_SURFACE_CLASS);
  });

  // The header has to make the SAME offset choice as the body or the column
  // label scrolls away from the values underneath it — visually wrong, and
  // silent.
  it("offsets the identity header by the same track the body uses", () => {
    renderSessionsGrid({ favorites: true });

    expect(leadHeaderCell().style.left).toBe(UTILITY_OFFSET_PX);
    expect(leadHeaderCell()).not.toHaveClass(LEFT_EDGE_CLASS);
  });

  // A pinned cell stops moving while its row keeps moving underneath it, so the
  // row's own 40%-opaque hover tint cannot be the pinned cell's background —
  // the columns passing behind would read through it. The tint is restated on
  // an overlay above an opaque surface instead, wired to the ROW's hover.
  it("carries the row hover tint on an overlay rather than as its background", () => {
    renderSessionsGrid({ favorites: false });

    expect(leadBodyCell()).toHaveClass("group-hover:before:bg-muted/40");
    expect(leadBodyCell()).not.toHaveClass("group-hover:bg-muted/40");
  });
});

function renderSessionsGrid({ favorites }: { favorites: boolean }) {
  stubContainerWidthPx(1400);
  renderWithFlags(
    <SessionsListGridV2
      columnOrder={COLUMNS.map((column) => column.id)}
      columns={COLUMNS}
      columnWidths={{ status: 160 }}
      favorites={
        favorites
          ? {
              favoriteIds: new Set<string>(),
              isUnavailable: false,
              onChange: () => undefined,
            }
          : undefined
      }
      gridTemplateColumns={favorites ? "36px 240px 160px" : "240px 160px"}
      headerActions={{
        getFilterContent: () => null,
        onGroup: () => undefined,
      }}
      items={ROWS}
      leadingColumnWidth={240}
      mode="expanded"
      onColumnWidthChange={() => undefined}
      onLeadingColumnWidthChange={() => undefined}
      onSort={() => undefined}
      renderCell={(columnId) => columnId}
      renderLead={(row) => <span>{row.name}</span>}
      selection={emptySessionsGridSelection()}
      showGroupCounts={false}
      sortBy={null}
      sortDir="asc"
    />,
    []
  );
}

function leadHeaderCell(): HTMLElement {
  return screen.getByRole("columnheader", { name: LEAD_HEADER_PATTERN });
}

/**
 * The row's identity cell, found through the session name it renders rather
 * than by class or position, so the query cannot drift onto a different cell as
 * the table's chrome changes.
 */
function leadBodyCell(): HTMLElement {
  return closestCell(screen.getByText(ROW_NAME), "session name");
}

/** The row's favourite cell, found through the control it holds. */
function favoriteBodyCell(): HTMLElement {
  return closestCell(
    screen.getByRole("button", { name: FAVORITE_LABEL }),
    "favorite control"
  );
}

function closestCell(node: HTMLElement, what: string): HTMLElement {
  const cell = node.closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`${what} is not inside a table cell`);
  }
  return cell;
}
