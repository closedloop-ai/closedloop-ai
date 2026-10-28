import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  createAgentSessionListItemFixture,
  createSessionCustomFieldFixture,
} from "@repo/app/agents/components/sessions/session-list-fixtures";
import {
  SESSION_CUSTOM_FIELD_WIDTH_PX,
  type SessionsCustomFieldsController,
  sessionsCustomFieldColumnId,
} from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import { isSessionsCustomFieldColumnId } from "@repo/app/agents/components/sessions/sessions-list-view-state";
import { useSessionsViewState } from "@repo/app/agents/hooks/use-sessions-view-state";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionSortDir } from "@repo/app/agents/lib/session-sort-group";
import { applySessionsHostViewChange } from "@repo/app/agents/lib/sessions-host-view-change";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import type { SessionsHostViewState } from "@repo/app/agents/lib/sessions-list-view-adapter";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useMemo } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionsListV2Host } from "@/components/agent-sessions/sessions-list-v2-host";

/**
 * ISS-10356 — the web half of the Sessions saved view's custom-field asymmetry,
 * through the REAL `useSessionsViewState` and the REAL `SessionsListV2Host`,
 * wired the way `sessions-v2-page.tsx` wires them.
 *
 * The ruling (Perrin, confirmed with Marisol, 2026-09-15): a custom-field column's
 * WIDTH belongs to the saved view; its VISIBILITY stays host-local (FEA-4222).
 * Both halves are asserted against the stored record itself, because a
 * width-only assertion stays green with visibility leaking into the record.
 */

const PERSIST_KEY = "sessions:web";
/** The per-user key `AppCoreStoryProviders`' static auth (`user_test`) writes. */
const STORAGE_KEY = `sessions:saved-view:${PERSIST_KEY}:u:user_test`;
const SESSION_ID = "ses-1";
// Names no built-in Sessions column carries (there is a built-in "Priority"),
// so each resize handle and menu row is the custom column's alone. UUID ids,
// as `CustomField.id` is: only such a column's width is saved.
const TIER_FIELD = createSessionCustomFieldFixture({
  id: "0197f3c2-0000-7000-8000-000000000001",
  name: "Tier",
});
const COHORT_FIELD = createSessionCustomFieldFixture({
  id: "0197f3c2-0000-7000-8000-000000000002",
  name: "Cohort",
});
const TIER_COLUMN_ID = sessionsCustomFieldColumnId(TIER_FIELD.id);
const COHORT_COLUMN_ID = sessionsCustomFieldColumnId(COHORT_FIELD.id);
const TIER_RESIZE_HANDLE = /^Resize Tier column,/;
/** The handle names the column's CURRENT width, so it is exact per column. */
const TIER_HANDLE_WIDTH = /^Resize Tier column, (\d+) pixels wide/;
const STORED_WIDTH_PX = 333;
const BUILT_IN_COLUMN_ID = "cost";
const BUILT_IN_WIDTH_PX = 277;
const DRAG_DELTA_PX = 80;
const WIDE_CONTAINER_PX = 1800;

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({ data: [], isError: false, isPending: false }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const CUSTOM_FIELDS: SessionsCustomFieldsController = {
  availableFields: [],
  fields: [TIER_FIELD, COHORT_FIELD],
  onCreateField: vi.fn(),
  valuesBySessionId: new Map(),
};

vi.mock("@repo/app/agents/hooks/use-sessions-custom-fields-controller", () => ({
  useSessionsCustomFieldsController: () => CUSTOM_FIELDS,
}));

const ITEMS: readonly AgentSessionListItem[] = [
  createAgentSessionListItemFixture({ id: SESSION_ID, name: "agent/one" }),
];

/** The page's half, as `sessions-v2-page.tsx` builds it from the same hook. */
function PageUnderTest() {
  const view = useSessionsViewState(PERSIST_KEY);
  const {
    dateRange,
    groupBy,
    secondarySorts,
    setGroupBy,
    setSecondarySorts,
    setSort,
    sortDir,
    sortKey,
    toggleColumn,
    visibleColumns,
  } = view;
  // Memoized per field, as the page does, so the host sees a new view only
  // when the saved view actually moved.
  const hostView: SessionsHostViewState = useMemo(
    () => ({
      dateRange,
      facets: DEFAULT_SESSION_FACET_FILTERS,
      groupBy,
      page: 0,
      scopeUserId: null,
      search: "",
      secondarySorts,
      sortDir,
      sortKey,
      visibleColumns,
    }),
    [dateRange, groupBy, secondarySorts, sortDir, sortKey, visibleColumns]
  );
  const onHostViewChange = useCallback(
    (next: SessionsHostViewState) =>
      applySessionsHostViewChange(
        next,
        { ...hostView, pageIndex: 0 },
        {
          onScopeChange: () => undefined,
          replacePage: () => undefined,
          setGroupBy,
          setSecondarySorts,
          setSort,
          toggleColumn,
        }
      ),
    [hostView, setGroupBy, setSecondarySorts, setSort, toggleColumn]
  );
  return (
    <SessionsListV2Host
      columnOrder={view.columnOrder}
      columnWidths={view.columnWidths}
      getSessionHref={(item) => `/acme/sessions/${item.id}`}
      hostView={hostView}
      isListPending={false}
      items={ITEMS}
      listReadState={SessionsListReadState.Settled}
      onColumnOrderChange={view.setColumnOrder}
      onColumnWidthChange={view.setColumnWidth}
      onHostViewChange={onHostViewChange}
      pageSize={25}
      summaryIsLoading={false}
      total={ITEMS.length}
      usage={undefined}
    />
  );
}

let restoreContainerWidth: (() => void) | null = null;

// jsdom implements no pointer capture; the resize drag calls it.
beforeAll(() => {
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {
      // no-op
    };
    Element.prototype.releasePointerCapture = () => {
      // no-op
    };
  }
});

afterEach(() => {
  localStorage.clear();
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

function renderPage() {
  restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
  return render(<PageUnderTest />, { wrapper: AppCoreStoryProviders });
}

/** A whole record: a partial one fails the schema and restores nothing. */
function storedRecord(columnWidths: Record<string, number>) {
  return {
    columnWidths,
    hiddenColumns: [],
    sortDir: SessionSortDir.Desc,
    sortKey: null,
  };
}

function readStoredRecord(): {
  columnOrder?: string[];
  columnWidths?: Record<string, number>;
  hiddenColumns?: string[];
} {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
}

function header(columnId: string) {
  return document.querySelector(
    `[role="columnheader"][data-column-id="${columnId}"]`
  );
}

/** The grid's resolved tracks, which `GridTableV2` puts on every data row. */
function gridTemplateColumns(): string {
  const row = document.querySelector<HTMLElement>("[data-grid-row-id]");
  if (!row) {
    throw new Error("the grid never rendered a row");
  }
  return row.style.gridTemplateColumns;
}

function tierColumnWidthPx(): number {
  const name =
    screen
      .getByRole("button", { name: TIER_RESIZE_HANDLE })
      .getAttribute("aria-label") ?? "";
  return Number(TIER_HANDLE_WIDTH.exec(name)?.[1]);
}

function dragTierColumn() {
  const handle = screen.getByRole("button", { name: TIER_RESIZE_HANDLE });
  fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
  fireEvent.pointerMove(handle, {
    clientX: 300 + DRAG_DELTA_PX,
    pointerId: 1,
  });
  fireEvent.pointerUp(handle, { pointerId: 1 });
}

function hideCohortColumn() {
  // Radix dropdowns open on `pointerdown`, not `click`.
  fireEvent.pointerDown(screen.getByRole("button", { name: "Options" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: COHORT_FIELD.name }));
  // The switch row keeps the menu open; close it so the grid is not
  // `aria-hidden` behind it.
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
}

describe("Sessions saved view — custom-field columns on the web page (ISS-10356)", () => {
  it("restores a custom-field column's stored width into its track", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(storedRecord({ [TIER_COLUMN_ID]: STORED_WIDTH_PX }))
    );

    renderPage();

    expect(tierColumnWidthPx()).toBe(STORED_WIDTH_PX);
    expect(gridTemplateColumns()).toContain(`${STORED_WIDTH_PX}px`);
  });

  it("restores a record written before custom-field widths were saved at the declared default", () => {
    // The shape every record written before this change has: a built-in width
    // and nothing for a custom field. It must restore exactly as it did — the
    // built-in width applied, the custom column on its declared default.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(storedRecord({ [BUILT_IN_COLUMN_ID]: BUILT_IN_WIDTH_PX }))
    );

    renderPage();

    expect(gridTemplateColumns()).toContain(`${BUILT_IN_WIDTH_PX}px`);
    expect(tierColumnWidthPx()).toBe(SESSION_CUSTOM_FIELD_WIDTH_PX);
  });

  it("saves a custom-field resize into the record, and never the reader's custom-field visibility", () => {
    renderPage();

    dragTierColumn();
    hideCohortColumn();

    // Both gestures still work — visibility host-local, for this mount.
    expect(header(COHORT_COLUMN_ID)).toBeNull();
    expect(tierColumnWidthPx()).toBe(
      SESSION_CUSTOM_FIELD_WIDTH_PX + DRAG_DELTA_PX
    );
    const stored = readStoredRecord();
    expect(stored.columnWidths?.[TIER_COLUMN_ID]).toBe(
      SESSION_CUSTOM_FIELD_WIDTH_PX + DRAG_DELTA_PX
    );
    // The half that is easy to add by accident: hiding a custom field must not
    // reach the record's visibility axes.
    expect(
      (stored.hiddenColumns ?? []).filter(isSessionsCustomFieldColumnId)
    ).toEqual([]);
    expect(
      (stored.columnOrder ?? []).filter(isSessionsCustomFieldColumnId)
    ).toEqual([]);
  });

  it("adopting a saved view from another tab restores widths and leaves which custom fields are shown alone", () => {
    renderPage();
    hideCohortColumn();
    expect(header(COHORT_COLUMN_ID)).toBeNull();

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: STORAGE_KEY,
          newValue: JSON.stringify(
            storedRecord({ [TIER_COLUMN_ID]: STORED_WIDTH_PX })
          ),
        })
      );
    });

    expect(tierColumnWidthPx()).toBe(STORED_WIDTH_PX);
    expect(header(COHORT_COLUMN_ID)).toBeNull();
  });
});
