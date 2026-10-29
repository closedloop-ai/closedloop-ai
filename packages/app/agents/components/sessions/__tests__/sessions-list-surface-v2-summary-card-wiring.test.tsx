import { TOTAL_ESTIMATED_COST_ALIAS_LABEL } from "@repo/api/src/types/total-estimated-cost-copy";
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
import { SESSIONS_METRIC_CARD_LABEL } from "../sessions-summary-card-labels";
import {
  SESSIONS_SUMMARY_CARD_IDS,
  SessionsSummaryCardId,
} from "../sessions-summary-card-visibility";
import { renderWithNav } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * FEA-4217 / ISS-5316 — the summary-card seam, asserted through the RENDERED
 * surface rather than the props it forwards.
 *
 * Three things a props-only assertion would have missed, all raised in review:
 *
 *  - the menu rows are a PAIR. With a handler but no hidden set the surface has
 *    no state to read the next render from, so every switch springs back ON
 *    however many times it is flipped — a control that does not work.
 *  - the hidden set has to reach the STRIP, not only the menus. A menu reporting
 *    Cost as off while the strip still paints it is the control lying about the
 *    view it owns.
 *  - hiding every card must drop the metric BAND. `SessionsSummaryCards` already
 *    returns null, so what survives is the surface's padded wrapper around
 *    nothing — an unexplained gap between the toolbar and the table.
 *
 * The mount is deliberately narrow (`usage` undefined, one row, one column):
 * this surface mounts a toolbar, four menus and the strip, and the neighbouring
 * files in this directory already sit near their timeout.
 */

const SURFACE_CLASS = "surface-under-test";
const OPTIONS_MENU_NAME = "Options";
const SUMMARY_CARDS_SECTION = "Summary cards";

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({
    id: "ses-1",
    name: "agent/first-row",
    status: "Active",
  }),
];

/**
 * The label the Cost tile actually paints here — the resolver's one answer for
 * every mode, which matters because this mount passes `usage` undefined. Naming
 * the wrong label would not fail loudly: the "withdraws a hidden card" case
 * asserts an ABSENCE, so a label the strip never paints makes it pass whether or
 * not hiding works.
 */
const COST_TILE_LABEL = TOTAL_ESTIMATED_COST_ALIAS_LABEL;

const NOTHING_HIDDEN: ReadonlySet<string> = new Set<string>();
const COST_HIDDEN: ReadonlySet<string> = new Set([SessionsSummaryCardId.Cost]);
const EVERY_CARD_HIDDEN: ReadonlySet<string> = new Set(
  SESSIONS_SUMMARY_CARD_IDS
);

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

function controlled(columnIds: readonly string[]) {
  return { value: viewWith(columnIds), onChange: () => undefined };
}

function renderSurface(
  props: Partial<React.ComponentProps<typeof SessionsListSurfaceV2>> = {}
) {
  return renderWithNav(
    <SessionsListSurfaceV2
      className={SURFACE_CLASS}
      controlledView={controlled(["status"])}
      rows={ROWS}
      usage={undefined}
      {...props}
    />
  );
}

/** Open the wide Options menu, where the metric rows live. */
function openOptionsMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: OPTIONS_MENU_NAME }),
    { button: 0, ctrlKey: false }
  );
}

/**
 * The list surface's bands, as `GridTableListSurface` lays them out: toolbar,
 * the optional metric band, table, and the optional pagination footer. Read off
 * the host `className` rather than a design-system class, so the count this
 * asserts cannot be changed by a styling edit one package over.
 */
function bandCount(container: HTMLElement): number {
  const root = container.querySelector(`.${SURFACE_CLASS}`);
  if (!root) {
    throw new Error("the surface did not render its host className");
  }
  return root.children.length;
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListSurfaceV2 summary-card menu rows", () => {
  it("offers metric rows when the host supplies both halves of the pair", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    renderSurface({
      hiddenSummaryCards: NOTHING_HIDDEN,
      onToggleSummaryCard: vi.fn(),
    });

    openOptionsMenu();

    expect(screen.getByText(SUMMARY_CARDS_SECTION)).toBeInTheDocument();
  });

  it("offers none with a toggle handler but no hidden set to read back", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    renderSurface({ onToggleSummaryCard: vi.fn() });

    openOptionsMenu();

    expect(screen.queryByText(SUMMARY_CARDS_SECTION)).toBeNull();
  });

  it("offers none with a hidden set but no handler to report a flip to", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    renderSurface({ hiddenSummaryCards: COST_HIDDEN });

    openOptionsMenu();

    expect(screen.queryByText(SUMMARY_CARDS_SECTION)).toBeNull();
  });

  it("reports a flip to the host carrying the card id", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onToggleSummaryCard = vi.fn();
    renderSurface({
      hiddenSummaryCards: NOTHING_HIDDEN,
      onToggleSummaryCard,
    });

    openOptionsMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: SESSIONS_METRIC_CARD_LABEL })
    );

    expect(onToggleSummaryCard).toHaveBeenCalledWith(
      SessionsSummaryCardId.Sessions
    );
  });
});

describe("SessionsListSurfaceV2 summary-card strip", () => {
  it("paints every card when the host hides none", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    renderSurface({ hiddenSummaryCards: NOTHING_HIDDEN });

    expect(screen.getByText(SESSIONS_METRIC_CARD_LABEL)).toBeInTheDocument();
    expect(screen.getByText(COST_TILE_LABEL)).toBeInTheDocument();
  });

  it("withdraws a hidden card from the strip and keeps the rest", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    renderSurface({ hiddenSummaryCards: COST_HIDDEN });

    expect(screen.queryByText(COST_TILE_LABEL)).toBeNull();
    expect(screen.getByText(SESSIONS_METRIC_CARD_LABEL)).toBeInTheDocument();
  });

  it("drops the metric band entirely once every card is hidden", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const withStrip = renderSurface({ hiddenSummaryCards: NOTHING_HIDDEN });
    const bandsWithStrip = bandCount(withStrip.container);
    withStrip.unmount();

    const allHidden = renderSurface({
      hiddenSummaryCards: EVERY_CARD_HIDDEN,
    });

    expect(screen.queryByText(SESSIONS_METRIC_CARD_LABEL)).toBeNull();
    expect(bandCount(allHidden.container)).toBe(bandsWithStrip - 1);
  });
});
