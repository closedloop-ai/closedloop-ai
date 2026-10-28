/**
 * ISS-9574 — the Sessions selected-count announcement, and why the bulk rail
 * could not carry it.
 *
 * `TableBulkActionBar` used to be the live region, but the list rail
 * (`ArtifactBulkActionBar`) returns `null` below two selected rows. A live
 * region announces only what changes while it is ALREADY in the document, so
 * the two moments that matter most — the rail arriving, and a filter or page
 * change shrinking the selection back under its threshold — are exactly the two
 * it is absent for. The region moved to an always-mounted
 * `TableSelectionAnnouncer` and the rail gave its `aria-live` up, because two
 * live regions on one sentence announce it twice.
 *
 * Driven through a CONTROLLED selection rather than simulated clicks: what is
 * under test is what the surface states about a selected set, and a test that
 * depended on the grid's pointer wiring would go green the moment that wiring
 * changed while the announcement stayed missing.
 */

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SESSIONS_STATUS_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  EMPTY_TABLE_GROUPING,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const ROWS = [
  createSessionTableRowFixture({ id: "ses-1", name: "agent/one" }),
  createSessionTableRowFixture({
    id: "ses-2",
    name: "agent/two",
    status: SESSION_STATUS.INACTIVE,
  }),
];

const VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  search: "",
  sortBy: null,
  sortDir: "desc",
  visibleColumnIds: new Set(["status"]),
};
const GROUPED_VIEW: SessionsListViewState = {
  ...VIEW,
  grouping: {
    ...EMPTY_TABLE_GROUPING,
    primary: {
      fieldId: SESSIONS_STATUS_COLUMN_ID,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
  },
};

/** A host that supplies a bulk operation, so selection is live at all. */
const FAVORITES = {
  favoriteIds: new Set<string>(),
  onChange: () => {
    // not under test
  },
  onToggleFavorite: () => {
    // not under test
  },
};

const NOTHING_SELECTED = "No sessions selected";
const ONE_SELECTED = "1 session selected";
const TWO_SELECTED = "2 sessions selected";
/** The rail's own visible sentence, which only ever reads plural. */
const BULK_RAIL_COPY = /sessions selected/;
const ACTIVE_GROUP_NAME = new RegExp(
  SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
);

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  cleanup();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderSurface(selectedIds: ReadonlySet<string>) {
  restoreContainerWidth = stubContainerWidthPx(1440);
  render(
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => {
          // not under test
        },
        totalRows: ROWS.length,
        value: VIEW,
      }}
      favorites={FAVORITES}
      rows={ROWS}
      selection={{
        onChange: () => {
          // controlled by the test, never moved by it
        },
        selectedIds,
      }}
      usage={undefined}
    />
  );
}

/**
 * The surface with a LIVE selection, so its active reconciliation owner can
 * write back.
 *
 * `renderSurface` pins what the surface SAYS about a given set. This pins what
 * happens when the set stops matching the rows — the flow a reader actually
 * hits, and the one neither the rule's unit test nor a fixed-selection render
 * crosses (davetho, PR #7320).
 */
function StatefulSelectionSurface({
  rows,
  initialSelectedIds,
  onSelectionChange,
  pageSize,
  totalRows = rows.length,
  view = VIEW,
}: {
  rows: readonly SessionTableRow[];
  initialSelectedIds: ReadonlySet<string>;
  onSelectionChange?: (selectedIds: ReadonlySet<string>) => void;
  pageSize?: number;
  totalRows?: number;
  view?: SessionsListViewState;
}) {
  const [selectedIds, setSelectedIds] =
    useState<ReadonlySet<string>>(initialSelectedIds);
  return (
    <SessionsListSurfaceV2
      controlledView={{
        onChange: () => {
          // not under test
        },
        totalRows,
        value: view,
      }}
      favorites={FAVORITES}
      pageSize={pageSize}
      rows={rows}
      selection={{
        onChange: (nextSelectedIds) => {
          onSelectionChange?.(nextSelectedIds);
          setSelectedIds(nextSelectedIds);
        },
        selectedIds,
      }}
      usage={undefined}
    />
  );
}

/** Selection-count regions; list-update announcements have a separate owner. */
function liveRegions(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("output[aria-live]")
  );
}

describe("Sessions selection announcement source precondition (ISS-9460)", () => {
  it("states the count in exactly ONE selection live region", () => {
    renderSurface(new Set(["ses-1", "ses-2"]));

    // The rail IS mounted at two rows and paints the same sentence, which is
    // what makes the count assertion load-bearing: leave `aria-live` on the rail
    // and a reader selecting a third row hears the new count twice.
    expect(screen.getByRole("toolbar", { name: TWO_SELECTED })).toBeVisible();
    const regions = liveRegions();
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toBe(TWO_SELECTED);
  });

  it("keeps stating it BELOW the bulk rail's two-row threshold", () => {
    // The whole reason the rail cannot carry this. At one row the rail is not in
    // the document, so a selection shrunk to one by a filter would announce
    // nothing at all.
    renderSurface(new Set(["ses-1"]));
    expect(screen.queryByText(BULK_RAIL_COPY)).toBeNull();

    expect(liveRegions()[0]?.textContent).toBe(ONE_SELECTED);
  });

  it("names the empty state rather than going silent", () => {
    renderSurface(new Set<string>());

    expect(liveRegions()[0]?.textContent).toBe(NOTHING_SELECTED);
  });

  it("speaks the singular at one row, not '1 sessions'", () => {
    // The `CountNoun` the rail, the count cells and this region now share. A
    // bare plural, or a tuple read by position, says "1 sessions selected" here.
    renderSurface(new Set(["ses-2"]));

    expect(liveRegions()[0]?.textContent).toBe(ONE_SELECTED);
  });

  it("follows a filter that takes the selected rows away: rail gone, region says so", () => {
    // The composed flow, end to end in one mount: a narrowing row set, the
    // surface's own reconcile write-back, the rail's threshold, and the
    // sentence. Each of those has its own unit; nothing joined them, so the
    // announcement could have been correct about a set that never updated.
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { rerender } = render(
      <StatefulSelectionSurface
        initialSelectedIds={new Set(["ses-1", "ses-2"])}
        rows={ROWS}
      />
    );

    expect(screen.getByRole("toolbar", { name: TWO_SELECTED })).toBeVisible();
    expect(liveRegions()[0]?.textContent).toBe(TWO_SELECTED);

    // The filter lands: neither selected row survives it.
    rerender(
      <StatefulSelectionSurface
        initialSelectedIds={new Set(["ses-1", "ses-2"])}
        rows={[]}
      />
    );

    // By ROLE and NAME, not by the rail's copy: the announcer's own empty
    // sentence contains "sessions selected" too, so a text query here passes
    // whether the rail went away or not.
    expect(screen.queryByRole("toolbar", { name: TWO_SELECTED })).toBeNull();
    const regions = liveRegions();
    // Still exactly one, and it is the one that CHANGED — the moment the rail
    // could never announce, because it had just unmounted.
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toBe(NOTHING_SELECTED);
  });

  it("writes once when a mounted filter transition removes a selected row", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <StatefulSelectionSurface
        initialSelectedIds={new Set(["ses-1", "ses-2"])}
        onSelectionChange={onSelectionChange}
        rows={ROWS}
      />
    );
    onSelectionChange.mockClear();

    rerender(
      <StatefulSelectionSurface
        initialSelectedIds={new Set(["ses-1", "ses-2"])}
        onSelectionChange={onSelectionChange}
        rows={ROWS.slice(0, 1)}
      />
    );

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onSelectionChange).toHaveBeenCalledWith(new Set(["ses-1"]));
  });

  it("writes once when a mounted page transition removes a selected row", () => {
    const first = ROWS[0];
    const second = ROWS[1];
    if (!(first && second)) {
      throw new Error("Expected two session rows");
    }
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    const { rerender } = render(
      <StatefulSelectionSurface
        initialSelectedIds={new Set([first.id])}
        onSelectionChange={onSelectionChange}
        pageSize={1}
        rows={[first]}
        totalRows={2}
      />
    );
    onSelectionChange.mockClear();

    rerender(
      <StatefulSelectionSurface
        initialSelectedIds={new Set([first.id])}
        onSelectionChange={onSelectionChange}
        pageSize={1}
        rows={[second]}
        totalRows={2}
        view={{ ...VIEW, page: 1 }}
      />
    );

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onSelectionChange).toHaveBeenCalledWith(new Set());
  });

  it("drops a selected row when its group collapses", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    render(
      <StatefulSelectionSurface
        initialSelectedIds={new Set(["ses-1", "ses-2"])}
        onSelectionChange={onSelectionChange}
        rows={ROWS}
        view={GROUPED_VIEW}
      />
    );
    onSelectionChange.mockClear();

    expect(liveRegions()[0]?.textContent).toBe(TWO_SELECTED);
    const activeGroup = screen.getByRole("button", {
      name: ACTIVE_GROUP_NAME,
    });
    expect(activeGroup.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(activeGroup);

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(activeGroup.getAttribute("aria-expanded")).toBe("false");
    expect(liveRegions()[0]?.textContent).toBe(ONE_SELECTED);
  });

  it("Ctrl+A includes only rendered rows after a group collapses", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <StatefulSelectionSurface
          initialSelectedIds={new Set()}
          onSelectionChange={onSelectionChange}
          rows={ROWS}
          view={GROUPED_VIEW}
        />
      </FeatureFlagAdapterProvider>
    );

    const activeGroup = screen.getByRole("button", {
      name: ACTIVE_GROUP_NAME,
    });
    fireEvent.click(activeGroup);
    expect(activeGroup).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("agent/one")).toBeNull();

    const renderedCell = document.querySelector<HTMLElement>(
      '[data-grid-row-id="ses-2"] [data-grid-cell]'
    );
    if (!renderedCell) {
      throw new Error("rendered Session cell not found");
    }
    expect(headerSelectAllCheckboxes()).toHaveLength(0);
    fireEvent.keyDown(renderedCell, { ctrlKey: true, key: "a" });

    expect(onSelectionChange).toHaveBeenLastCalledWith(new Set(["ses-2"]));
    expect(liveRegions()[0]?.textContent).toBe(ONE_SELECTED);
    expect(headerSelectAllCheckboxes()).toHaveLength(0);
  });

  it("Ctrl+A follows rendered group order rather than input order", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onSelectionChange = vi.fn();
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <StatefulSelectionSurface
          initialSelectedIds={new Set()}
          onSelectionChange={onSelectionChange}
          rows={[...ROWS].reverse()}
          view={GROUPED_VIEW}
        />
      </FeatureFlagAdapterProvider>
    );

    const renderedCell = document.querySelector<HTMLElement>(
      '[data-grid-row-id="ses-1"] [data-grid-cell]'
    );
    if (!renderedCell) {
      throw new Error("rendered Session cell not found");
    }
    expect(headerSelectAllCheckboxes()).toHaveLength(0);
    fireEvent.keyDown(renderedCell, { ctrlKey: true, key: "a" });

    expect(Array.from(onSelectionChange.mock.lastCall?.[0] ?? [])).toEqual([
      "ses-1",
      "ses-2",
    ]);
    expect(headerSelectAllCheckboxes()).toHaveLength(0);
  });
});

const HEADER_SELECT_ALL_CHECKBOX_NAME = /^(select|deselect) all$/i;

function headerSelectAllCheckboxes() {
  return screen.queryAllByRole("checkbox", {
    name: HEADER_SELECT_ALL_CHECKBOX_NAME,
  });
}
