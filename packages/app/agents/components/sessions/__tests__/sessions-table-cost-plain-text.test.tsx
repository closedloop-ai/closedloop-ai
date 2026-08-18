import { CostAvailability } from "@repo/app/agents/lib/cost-availability";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SESSION_COST_CELL_TEST_ID } from "../session-cost-cell";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsTable, type SessionTableRow } from "../sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5840 — the Cost column renders plain text, and renders the SAME plain text
 * whether or not the row has an explanation to offer.
 *
 * The counterfactual is the point of this file. Before the change the column
 * routed through `renderTooltipChip`, whose scaffold is `Chip variant="outline"`
 * — so a row WITH a `costTooltip` rendered inside a bordered, rounded pill and a
 * row WITHOUT one rendered as a bare span. That is the reported defect exactly:
 * twelve pilled rows and one bare `$1.01`, split not by cost but by whether
 * `COST_TOOLTIP` had anything to say about the row's `CostAvailability`.
 *
 * Every assertion here fails on the pre-change component:
 *  - the pill test finds `Chip`'s `rounded-full`/`border` on the subscription row;
 *  - the parity test finds two different class strings for the two rows;
 *  - the tabular-nums test finds the class absent from the chip's inner span.
 */

// A subscription-covered row: `COST_TOOLTIP` gives it an explanation, so this is
// the row that used to draw the pill.
const SUBSCRIPTION_ROW: SessionTableRow = createSessionTableRowFixture({
  id: "session-subscription",
  costAvailability: CostAvailability.Subscription,
  costLabel: "$658.29",
  costTooltip: "Billed through your subscription",
});

// The `$1.01` row from the report: a genuinely priced, API-billed cost.
// `COST_TOOLTIP[Available]` is deliberately `null` — a real figure needs no
// explanation — so this row never had a tooltip and never drew a pill.
const AVAILABLE_ROW: SessionTableRow = createSessionTableRowFixture({
  id: "session-available",
  costAvailability: CostAvailability.Available,
  costLabel: "$1.01",
  costTooltip: null,
});

// An API-billed figure wider than the 124px Cost track at `text-sm`, and well
// inside `formatCost`'s range. `Available` ⇒ `costTooltip` is `null`, so there is
// no disclosure to fall back on if the cell clips.
const OVERSIZE_COST_LABEL = "$1,226,540.10";
const OVERSIZE_ROW: SessionTableRow = createSessionTableRowFixture({
  id: "session-oversize",
  costAvailability: CostAvailability.Available,
  costLabel: OVERSIZE_COST_LABEL,
  costTooltip: null,
});

function renderName(row: SessionTableRow, className: string) {
  return (
    <a className={className} href={`/sessions/${row.id}`}>
      {row.name}
    </a>
  );
}

function renderTable(items: SessionTableRow[]) {
  render(
    <SessionsTable items={items} mode="expanded" renderName={renderName} />
  );
  return screen.getAllByTestId(SESSION_COST_CELL_TEST_ID);
}

describe("Sessions Cost column renders plain numbers (ISS-5840)", () => {
  it("wraps a tooltip-carrying cost in no pill, border, or chip background", () => {
    const [cell] = renderTable([SUBSCRIPTION_ROW]);

    expect(cell).toHaveTextContent("$658.29");
    // `Chip` ships its pill as a rounded, bordered, background-filled box. None
    // of those may survive on the cost cell or on anything wrapping it inside
    // the grid cell.
    for (const chipClass of PILL_CLASSES) {
      expect(cell.className).not.toContain(chipClass);
      expect(cell.closest(`.${chipClass}`)).toBeNull();
    }
  });

  it("gives the explained and unexplained rows one identical text treatment", () => {
    // The reported defect in one assertion: `$658.29` (explained) and `$1.01`
    // (unexplained) sat in the same column looking like two components. Both now
    // carry the identical type treatment, and neither carries the pill. The
    // explained row keeps a focus-ring/cursor delta because it is an actual
    // control (see the keyboard test below) — that is the ONLY permitted
    // difference, so this asserts the shared treatment rather than raw equality.
    const cells = renderTable([SUBSCRIPTION_ROW, AVAILABLE_ROW]);

    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveTextContent("$658.29");
    expect(cells[1]).toHaveTextContent("$1.01");
    for (const cell of cells) {
      expect(cell.className).toContain("text-sm");
      expect(cell.className).toContain("tabular-nums");
      for (const chipClass of PILL_CLASSES) {
        expect(cell.className).not.toContain(chipClass);
      }
    }
  });

  it("keeps the explanation reachable without a mouse after the chip is gone", () => {
    // The chip supplied `interactive tabIndex={0}`; dropping to a bare span
    // would have silently removed the keyboard path to the tooltip. The
    // explained row stays a focusable control, the unexplained row does not
    // become one (there is nothing to reveal).
    const cells = renderTable([SUBSCRIPTION_ROW, AVAILABLE_ROW]);

    expect(cells[0].tagName).toBe("BUTTON");
    expect(cells[1].tagName).toBe("SPAN");
  });

  it("aligns digits with tabular-nums so the column can be scanned", () => {
    const cells = renderTable([SUBSCRIPTION_ROW, AVAILABLE_ROW]);

    for (const cell of cells) {
      expect(cell.className).toContain("tabular-nums");
    }
  });

  it("never ellipsizes a figure too wide for the Cost track", () => {
    // wongk review: the first cut carried `truncate` (inherited from the chip's
    // inner span) onto the plain path. `Available` rows have NO tooltip by
    // contract, so an ellipsized API-billed cost is unrecoverable — and a
    // clipped currency string reads as a smaller number rather than as a
    // shortened label (ISS-4891, the reason the Cost track is 124px at all).
    // Asserted on the class because jsdom lays out no text: the geometry half
    // lives in the `textOverflows` legs of the web and Electron legibility e2e.
    const [cell] = renderTable([OVERSIZE_ROW]);

    expect(cell).toHaveTextContent(OVERSIZE_COST_LABEL);
    for (const clippingClass of CLIPPING_CLASSES) {
      expect(cell.className).not.toContain(clippingClass);
      expect(cell.closest(`.${clippingClass}`)).toBeNull();
    }
  });

  it("still renders the shared empty glyph for a session that never ran", () => {
    // ISS-4418 behaviour is untouched: a no-usage session shows the shared grid
    // empty glyph, never a `$0.00` it did not earn — and it renders no cost cell
    // of its own, which is why this case cannot go through `renderTable`.
    render(
      <SessionsTable
        items={[
          createSessionTableRowFixture({
            id: "session-idle",
            costAvailability: CostAvailability.NoUsage,
            costLabel: "—",
            costTooltip: null,
          }),
        ]}
        mode="expanded"
        renderName={renderName}
      />
    );

    expect(screen.queryByTestId(SESSION_COST_CELL_TEST_ID)).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
  });
});

/**
 * The three marks `Chip variant="outline"` puts on its box — the pill SHAPE
 * (`rounded-full`, from `chipVariants`' base), the chip BACKGROUND (`bg-input`)
 * and the BORDER (`border-input-border`). One per clause of ISS-5840's
 * acceptance criterion 1 ("no pill, no border, no chip background"), kept as a
 * list rather than one check so a failure names which piece came back.
 *
 * Deliberately NOT the bare string `"border"`: the focusable trigger carries
 * `CHIP_FOCUS_RING_CLASS`, whose `focus-visible:border-ring` contains it as a
 * substring. A test that cannot tell a focus ring from a chip border would go
 * red on correct code.
 */
const PILL_CLASSES = ["rounded-full", "bg-input", "border-input-border"];

/**
 * The two ways Tailwind ellipsizes: the `truncate` shorthand (which is what the
 * chip's inner span used) and the bare `text-ellipsis` half of it. Neither may
 * appear on the cost cell or on anything wrapping it inside the grid cell —
 * `overflow-hidden` alone is deliberately NOT listed, because scroll containers
 * above the grid legitimately carry it and clipping without an ellipsis is a
 * geometry question the legibility e2e answers on the real surface.
 */
const CLIPPING_CLASSES = ["truncate", "text-ellipsis"];
