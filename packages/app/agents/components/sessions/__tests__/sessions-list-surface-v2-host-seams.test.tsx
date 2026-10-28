import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSIONS_COLUMN_SPECS,
  SESSIONS_DATA_COLUMN_ORDER,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
} from "../../../lib/sessions-table-columns";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";
import { renderWithNav } from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

/**
 * ISS-7262 — the HOST SEAMS `SessionsListSurfaceV2` needs before any real
 * Sessions list can mount it without giving up something it can do today.
 *
 * Each seam is opt-in and each is asserted against the RENDERED surface rather
 * than the props it was handed, with the seam-absent branch as the sibling: an
 * assertion that only proves "the seam ran" would stay green for a surface that
 * ignored the seam-absent contract these columns depend on.
 *
 * The mounts are deliberately few and narrow (`visibleColumnIds` naming only the
 * columns a case reads). This surface mounts a toolbar, four menus and the
 * summary strip, and the neighbouring files in this directory already sit near
 * their timeout — see the note in `sessions-list-surface-v2-seam-columns`.
 */

const LAST_ACTIVITY_LABEL = "17 minutes ago";

const ROWS: readonly SessionTableRow[] = [
  createSessionTableRowFixture({
    id: "ses-1",
    lastActivityLabel: LAST_ACTIVITY_LABEL,
    name: "agent/first-row",
    repo: "closedloop-ai/closedloop-ai",
    status: "Active",
    user: { avatarUrl: null, id: "user-pascoe", name: "Pascoe Birchall" },
  }),
];

const SESSION_NAME = "agent/first-row";

/** A view naming exactly the columns a case reads, to keep the mount cheap. */
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

/** The canonical grid track for a column id, as the surface emits it. */
function specWidth(columnId: string): string {
  const spec = SESSIONS_COLUMN_SPECS.find((entry) => entry.id === columnId);
  if (!spec) {
    throw new Error(`no column spec for "${columnId}"`);
  }
  return spec.width;
}

/** The one inline `grid-template-columns` the rendered grid carries. */
function readGridTemplate(container: HTMLElement): string {
  for (const element of container.querySelectorAll<HTMLElement>("[style]")) {
    if (element.style.gridTemplateColumns) {
      return element.style.gridTemplateColumns;
    }
  }
  throw new Error("no element carried a grid-template-columns track list");
}

/**
 * A minimal `DataTransfer` stand-in — jsdom fires drag events without one, and
 * the header's drag contract is a `setData`/`getData` round-trip over a single
 * key, so nothing richer is needed to drive the real handlers.
 */
function createDataTransfer() {
  const store = new Map<string, string>();
  return {
    dropEffect: "",
    effectAllowed: "",
    types: [] as string[],
    setData(type: string, value: string) {
      store.set(type, value);
      this.types.push(type);
    },
    getData(type: string) {
      return store.get(type) ?? "";
    },
  };
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

pinSessionFixtureClock();

describe("SessionsListSurfaceV2 host seams", () => {
  /**
   * The navigation seam. `GridTableV2` offers only `onRowClick`, which AGENTS.md
   * forbids as an in-app navigation mechanism, so a surface whose rows a user
   * needs to open has to render a real `@repo/navigation` `Link` — which is what
   * this asserts, by ROLE, so a `div` carrying a click handler cannot satisfy it.
   */
  it("links the session name at the host's href, and renders plain text without the seam", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { unmount } = renderWithNav(
      <SessionsListSurfaceV2
        controlledView={controlled(["status"])}
        getSessionHref={(row) => `/sessions/${row.id}`}
        rows={ROWS}
        usage={undefined}
      />
    );

    expect(screen.getByRole("link", { name: SESSION_NAME })).toHaveAttribute(
      "href",
      "/sessions/ses-1"
    );
    unmount();

    // The sibling branch: without the seam the name is still ON SCREEN — so the
    // assertion above cannot be satisfied by a mount that simply failed — but it
    // is not a link, because there is no route for it to claim.
    renderWithNav(
      <SessionsListSurfaceV2
        controlledView={controlled(["status"])}
        rows={ROWS}
        usage={undefined}
      />
    );

    expect(screen.getByText(SESSION_NAME)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: SESSION_NAME })
    ).not.toBeInTheDocument();
  }, 20_000);

  /**
   * The linked-entity seams (FEA-4209 / FEA-4210), asserted PER COLUMN.
   *
   * Supplying one seam and not the other is the case that separates a real
   * per-column gate from a blanket "the host passed something" flag: the
   * unsupplied column must stay dropped, because a `SessionTableRow` still
   * cannot fill it and a rendered track would be em dashes with no menu entry to
   * switch off.
   */
  it("renders only the seam-required column whose seam the host supplied", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = renderWithNav(
      <SessionsListSurfaceV2
        controlledView={controlled([
          "status",
          SESSIONS_PROJECTS_COLUMN_ID,
          SESSIONS_ISSUES_COLUMN_ID,
        ])}
        renderProjects={(row) => <span>{`project for ${row.id}`}</span>}
        rows={ROWS}
        usage={undefined}
      />
    );

    expect(
      container.querySelector(
        `[data-column-id="${SESSIONS_PROJECTS_COLUMN_ID}"]`
      )
    ).not.toBeNull();
    expect(screen.getByText("project for ses-1")).toBeInTheDocument();
    expect(
      container.querySelector(`[data-column-id="${SESSIONS_ISSUES_COLUMN_ID}"]`)
    ).toBeNull();
  }, 20_000);

  /**
   * The FEA-4021 reorder pass-through, asserted on BOTH halves of its contract.
   *
   * The rendered column sequence must follow the host's order, and the grid
   * tracks must follow it too — `gridTemplateColumns` is caller-owned, so a
   * surface that reordered the columns without reordering its own tracks would
   * pair every column with the wrong width and still pass a headers-only check.
   */
  it("renders the host's column order, with the grid tracks in the same order", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = renderWithNav(
      <SessionsListSurfaceV2
        columnOrder={["repo", "status"]}
        controlledView={controlled(["status", "repo"])}
        rows={ROWS}
        usage={undefined}
      />
    );

    const renderedIds = Array.from(
      container.querySelectorAll("[data-column-id]")
    ).map((element) => element.getAttribute("data-column-id"));

    expect(renderedIds.indexOf("repo")).toBeLessThan(
      renderedIds.indexOf("status")
    );
    // The canonical declaration puts Status before Repository, so the assertion
    // above is only satisfiable by a surface that actually applied the order.
    expect(SESSIONS_DATA_COLUMN_ORDER.indexOf("status")).toBeLessThan(
      SESSIONS_DATA_COLUMN_ORDER.indexOf("repo")
    );

    // `repo` is 180px and `status` 132px, so the two tracks are distinguishable
    // by value — the pairing is asserted on the widths themselves, not on a
    // position that a same-width pair would satisfy either way.
    const tracks = readGridTemplate(container);

    expect(tracks).toContain(specWidth("repo"));
    expect(tracks.indexOf(specWidth("repo"))).toBeLessThan(
      tracks.indexOf(specWidth("status"))
    );
  }, 20_000);

  /**
   * The reorder handle only exists when the host wired a change handler, and the
   * order it reports back is the COMPLETE data order, not the visible subset —
   * persisting the subset would drop a hidden column's remembered slot, so
   * re-showing it would append it at the far right of a table that already
   * overflows.
   */
  it("reports a reorder merged back into the complete column order", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onColumnOrderChange = vi.fn();
    const { container } = renderWithNav(
      <SessionsListSurfaceV2
        columnOrder={["status", "repo"]}
        controlledView={controlled(["status", "repo"])}
        onColumnOrderChange={onColumnOrderChange}
        rows={ROWS}
        usage={undefined}
      />
    );

    const header = (columnId: string) => {
      const element = container.querySelector<HTMLElement>(
        `[role="columnheader"][data-column-id="${columnId}"]`
      );
      if (!element) {
        throw new Error(`no rendered header for "${columnId}"`);
      }
      return element;
    };
    // The wiring itself: only a table handed a change handler makes its headers
    // drag surfaces, so this is the affordance the seam exists to grow.
    expect(header("repo").getAttribute("draggable")).toBe("true");

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(header("repo"), { dataTransfer });
    fireEvent.drop(header("status"), { dataTransfer });

    expect(onColumnOrderChange).toHaveBeenCalledTimes(1);
    const reported = onColumnOrderChange.mock.calls[0][0] as string[];

    expect(reported.indexOf("repo")).toBeLessThan(reported.indexOf("status"));
    // Merged back, so every canonical id survives — not just the two on screen.
    // Reporting the visible subset would drop every hidden column's remembered
    // slot, which is the regression this wrapper exists to prevent.
    expect(new Set(reported)).toEqual(new Set(SESSIONS_DATA_COLUMN_ORDER));
  }, 20_000);

  /**
   * Codex P2 review. `mergeColumnOrder` leaves every NON-visible id in the slot
   * the list it is given puts it in, so merging into the canonical order rewrote
   * the host's hidden columns back to canonical positions on any reorder of the
   * visible ones — a user who had arranged their hidden columns and then dragged
   * two visible headers silently lost the rest of that arrangement, with nothing
   * in the UI showing it until they re-enabled a column and found it elsewhere.
   *
   * The fixture is a persisted order whose HIDDEN tail is deliberately not in
   * canonical order, because a saved order that already agrees with canonical
   * cannot tell the two merges apart.
   */
  it("preserves the host's order for the columns it is not reordering", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const onColumnOrderChange = vi.fn();
    // Canonical order, with the two hidden ids that trail `repo`/`status`
    // deliberately swapped relative to it.
    const canonicalTail = SESSIONS_DATA_COLUMN_ORDER.filter(
      (id) => id !== "status" && id !== "repo"
    );
    const savedTail = [
      canonicalTail[1],
      canonicalTail[0],
      ...canonicalTail.slice(2),
    ].filter((id): id is string => id !== undefined);
    const savedOrder = ["status", "repo", ...savedTail];

    const { container } = renderWithNav(
      <SessionsListSurfaceV2
        columnOrder={savedOrder}
        controlledView={controlled(["status", "repo"])}
        onColumnOrderChange={onColumnOrderChange}
        rows={ROWS}
        usage={undefined}
      />
    );

    const header = (columnId: string) => {
      const element = container.querySelector<HTMLElement>(
        `[role="columnheader"][data-column-id="${columnId}"]`
      );
      if (!element) {
        throw new Error(`no rendered header for "${columnId}"`);
      }
      return element;
    };
    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(header("repo"), { dataTransfer });
    fireEvent.drop(header("status"), { dataTransfer });

    const reported = onColumnOrderChange.mock.calls[0][0] as string[];
    // The drag did what it said: the two VISIBLE ids swapped.
    expect(reported.indexOf("repo")).toBeLessThan(reported.indexOf("status"));
    // And the hidden tail kept the host's relative order rather than being
    // rewritten to canonical. This is the assertion the canonical merge fails.
    const reportedTail = reported.filter(
      (id) => id !== "status" && id !== "repo"
    );
    expect(reportedTail).toEqual(savedTail);
    // Anti-vacuity: the saved tail really did differ from canonical, so the
    // assertion above cannot pass by the two lists being the same list.
    expect(savedTail).not.toEqual(canonicalTail);
  }, 20_000);

  it("leaves the headers static when no change handler is wired", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = renderWithNav(
      <SessionsListSurfaceV2
        columnOrder={["status", "repo"]}
        controlledView={controlled(["status", "repo"])}
        rows={ROWS}
        usage={undefined}
      />
    );

    expect(
      container
        .querySelector('[role="columnheader"][data-column-id="repo"]')
        ?.getAttribute("draggable")
    ).toBe("false");
    fireEvent.click(
      screen.getByRole("button", { name: "Repository column options" })
    );
    expect(screen.queryByText("Move column")).not.toBeInTheDocument();
  }, 20_000);
});

/**
 * One of the two lies the reader map was telling before ISS-7262 wired the
 * missing ids.
 *
 * Kept out of the `host seams` block above because it is not about a seam: it is
 * about the surface being honest with the row it already holds. Its sibling —
 * "can sort by every column the geometry marks sortable" — moved to
 * `sessions-list-surface-v2-value-sort.test.ts` when ISS-8013 widened that
 * invariant from "has a CELL reader" to "has a SORT RULE", so the guard sits
 * with the sort behaviour it polices.
 */
describe("SessionsListSurfaceV2 cell values", () => {
  /**
   * `TableTextCell` renders "" as the em dash that means "this record has no
   * value here", so a `lastActivity` with no reader printed "—" on a row whose
   * `lastActivityLabel` the `Updated` column beside it was already showing.
   */
  it("renders the row's last-activity value rather than the no-value glyph", () => {
    restoreContainerWidth = stubContainerWidthPx(1440);
    const { container } = renderWithNav(
      <SessionsListSurfaceV2
        controlledView={controlled(["lastActivity"])}
        rows={ROWS}
        usage={undefined}
      />
    );

    const cell = container.querySelector(
      '[role="gridcell"][data-column-id="lastActivity"]'
    );

    // The fixture's own value, so a reader pointed at a neighbouring field
    // renders something else and fails rather than coincidentally matching.
    expect(cell).toHaveTextContent(LAST_ACTIVITY_LABEL);
    // The positive sibling for the glyph half: an id the row genuinely has no
    // value for still renders the em dash, so the assertion above cannot be
    // satisfied by a cell that simply stopped emitting it.
    expect(cell?.textContent).not.toBe("—");
  }, 20_000);
});
