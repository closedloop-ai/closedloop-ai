import type {
  CustomFieldValueDetail,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { SESSIONS_STATUS_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { pinSessionFixtureClock } from "@repo/app/test/mocks/session-fixture-clock";
import {
  EMPTY_TABLE_GROUPING,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_MODEL_CHIP_TEST_ID } from "../session-cell-chips";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import {
  renderSessionCell,
  SessionsListLeadCell,
} from "../sessions-list-surface-rows";
import { SessionsListSurfaceV2 } from "../sessions-list-surface-v2";
import type { SessionsListViewState } from "../sessions-list-view-state";

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

const LIVE_UPDATE_STATUS_TEST_ID = "sessions-live-update-status";
const ROW = createSessionTableRowFixture({
  autonomy: 88,
  branch: "fea/grid-table-v2",
  id: "session-contract",
  model: "claude-opus-5",
  repo: "closedloop-ai/closedloop-ai",
  status: "Active",
  updatedLabel: "4m ago",
});

const VISIBLE_COLUMN_IDS = new Set([
  "status",
  "owner",
  "harness",
  "model",
  "repo",
  "cost",
  "duration",
  "autonomy",
  "branches",
  "started",
  "updated",
  "lastActivity",
]);
const FIELD_TITLE_PATTERN = /Field title/;
const CARD_ONE_FAVORITE_PATTERN = /Card 1.*favorites/;
// ISS-8068 (#5993) put the column's current width inside the v2 resize handle's
// accessible name, so match the shape rather than a width this test does not own.
const RE_MODEL_RESIZE_HANDLE =
  /^Resize Model column, \d+ pixels wide(, minimum)?, use arrow keys$/;

const VIEW: SessionsListViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  grouping: EMPTY_TABLE_GROUPING,
  page: 0,
  scopeUserId: null,
  sortBy: null,
  sortDir: "asc",
  visibleColumnIds: VISIBLE_COLUMN_IDS,
};

function createDataTransfer() {
  const values = new Map<string, string>();
  return {
    dropEffect: "",
    effectAllowed: "",
    types: [] as string[],
    getData(type: string) {
      return values.get(type) ?? "";
    },
    setData(type: string, value: string) {
      values.set(type, value);
      this.types.push(type);
    },
  };
}

function readGridTemplate(container: HTMLElement): string {
  for (const element of container.querySelectorAll<HTMLElement>("[style]")) {
    if (element.style.gridTemplateColumns) {
      return element.style.gridTemplateColumns;
    }
  }
  throw new Error("no grid-template-columns style found");
}

let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

pinSessionFixtureClock();

describe("SessionsListSurfaceV2 grid-table contract", () => {
  it("keeps the status word once when a compact Sessions card is grouped by status", () => {
    const groupedRow = createSessionTableRowFixture({
      ...ROW,
      status: SESSION_STATUS.ACTIVE,
    });
    const grouping = {
      ...EMPTY_TABLE_GROUPING,
      primary: {
        fieldId: SESSIONS_STATUS_COLUMN_ID,
        order: TableGroupOrder.Ascending,
        showEmptyGroups: false,
      },
    };
    const renderGrouped = (enabledFlags: readonly string[]) =>
      render(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: [...enabledFlags],
          })}
        >
          <SessionsListSurfaceV2
            initialGrouping={grouping}
            mode="compact"
            rows={[groupedRow]}
            usage={undefined}
          />
        </FeatureFlagAdapterProvider>
      );

    const closed = renderGrouped([]);
    expect(screen.getAllByText("Active")).toHaveLength(2);
    closed.unmount();

    renderGrouped([UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]);
    expect(screen.getAllByText("Running")).toHaveLength(1);
  });

  it("renders Sessions values through the matching v2 cell treatments", () => {
    const seamRenderers = new Map();
    const { container } = render(
      <div>
        {[...VISIBLE_COLUMN_IDS].map((columnId) => (
          <div data-testid={`cell-${columnId}`} key={columnId}>
            {renderSessionCell(columnId, ROW, seamRenderers)}
          </div>
        ))}
        <div data-testid="lead-cell">
          <SessionsListLeadCell row={ROW} />
        </div>
      </div>
    );

    const modelCell = screen.getByTestId("cell-model");
    expect(within(modelCell).getByText("claude-opus-5")).toBeInTheDocument();
    expect(modelCell.querySelector("span[aria-hidden]")).toHaveClass(
      "text-primary"
    );
    expect(
      modelCell.querySelector(`[data-testid="${SESSION_MODEL_CHIP_TEST_ID}"]`)
    ).not.toBeNull();
    expect(screen.getAllByTestId("tooltip-content")[0]).toHaveTextContent(
      "Anthropic · claude-opus-5"
    );

    const repositoryCell = screen.getByTestId("cell-repo");
    expect(repositoryCell.querySelector(".truncate")).toHaveTextContent(
      "closedloop-ai/closedloop-ai"
    );
    expect(repositoryCell.querySelector("svg")).not.toBeNull();
    expect(within(repositoryCell).getByRole("tooltip")).toHaveTextContent(
      "closedloop-ai/closedloop-ai"
    );

    expect(screen.getByTestId("cell-owner")).toHaveTextContent("—");
    expect(
      screen.getByTestId("cell-owner").querySelector('[data-slot="avatar"]')
    ).toBeNull();
    expect(screen.getByTestId("cell-harness")).toHaveTextContent("Claude");
    expect(screen.getByTestId("cell-status")).toHaveTextContent("Active");
    expect(screen.getByTestId("cell-cost").firstElementChild).toHaveClass(
      "tabular-nums"
    );
    expect(screen.getByTestId("cell-duration").firstElementChild).toHaveClass(
      "tabular-nums"
    );
    const branchCell = screen.getByTestId("cell-branches");
    expect(
      branchCell.querySelector('[data-slot="tooltip-trigger"]')
    ).not.toBeNull();
    expect(branchCell.querySelector(".truncate")).toHaveTextContent(
      "fea/grid-table-v2"
    );
    for (const columnId of ["started", "updated", "lastActivity"]) {
      expect(
        screen.getByTestId(`cell-${columnId}`).firstElementChild
      ).toHaveClass("text-sm", "text-muted-foreground");
    }
    expect(
      screen.getByTestId("lead-cell").querySelector(".text-sm")
    ).not.toBeNull();
    expect(container).toHaveTextContent("High");
  });

  it("ships actionable v2 headers, internal reorder/resize, and the production footer", async () => {
    restoreContainerWidth = stubContainerWidthPx(1800);
    const rows: SessionTableRow[] = Array.from({ length: 25 }, (_, index) => ({
      ...ROW,
      id: `session-${index + 1}`,
      name: `Session ${index + 1}`,
    }));
    const { container } = render(
      <SessionsListSurfaceV2
        controlledView={{
          onChange: () => undefined,
          totalRows: 1047,
          value: VIEW,
        }}
        onPageSizeChange={() => undefined}
        rows={rows}
        usage={undefined}
      />
    );

    const header = (columnId: string) => {
      const element = container.querySelector<HTMLElement>(
        `[role="columnheader"][data-column-id="${columnId}"]`
      );
      if (!element) {
        throw new Error(`no ${columnId} header`);
      }
      return element;
    };
    expect(header("model")).toHaveAttribute("draggable", "true");

    await userEvent.click(
      screen.getByRole("button", { name: "Model column options" })
    );
    expect(
      await screen.findByRole("menuitem", { name: "Sort ascending" })
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Group" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Move column" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });

    const beforeResize = readGridTemplate(container);
    fireEvent.keyDown(screen.getByLabelText(RE_MODEL_RESIZE_HANDLE), {
      key: "ArrowRight",
    });
    expect(readGridTemplate(container)).not.toBe(beforeResize);

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(header("model"), { dataTransfer });
    fireEvent.drop(header("status"), { dataTransfer });
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement>('[role="columnheader"]')
      ).findIndex((element) => element.dataset.columnId === "model")
    ).toBeLessThan(
      Array.from(
        container.querySelectorAll<HTMLElement>('[role="columnheader"]')
      ).findIndex((element) => element.dataset.columnId === "status")
    );

    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toHaveTextContent("25 / page");
    // The footer readout, not the surface's live-update `<output>`, which is
    // also an implicit `status` region (it stays empty without a live update).
    const footerStatuses = screen
      .getAllByRole("status")
      .filter(
        (element) => element.dataset.testid !== LIVE_UPDATE_STATUS_TEST_ID
      );
    expect(footerStatuses).toHaveLength(1);
    expect(footerStatuses[0]).toHaveTextContent(
      "Showing 1-25 of 1,047 sessions"
    );
  }, 20_000);

  it("carries range selection, artifact favorites, custom fields, and Add field into the grid", async () => {
    restoreContainerWidth = stubContainerWidthPx(1800);
    const createField = vi.fn(() => TEST_CUSTOM_FIELD);
    const favoriteChange = vi.fn();
    const rows = Array.from({ length: 4 }, (_, index) => ({
      ...ROW,
      id: `interactive-${index + 1}`,
      name: `Interactive ${index + 1}`,
    }));
    const { container } = render(
      <InteractiveContractHarness
        createField={createField}
        favoriteChange={favoriteChange}
        rows={rows}
      />
    );

    expect(
      container.querySelector('[data-column-id="custom-field:summary"]')
    ).not.toBeNull();
    expect(screen.getAllByText("Grid ready")).toHaveLength(2);

    // DATA rows only. ISS-10245 made `navigableHeaderCells` unconditional, so
    // the chrome header row carries `data-grid-row-id` too — as `renderedRows[0]`
    // it swallowed the click and selected nothing.
    const renderedRows = Array.from(
      container.querySelectorAll<HTMLElement>("[data-grid-row-id]")
    ).filter((row) => !isGridChromeRowId(row.dataset.gridRowId ?? ""));
    fireEvent.click(
      renderedRows[0]?.querySelector('[data-column-id="status"]') as Element
    );
    expect(
      screen.queryByRole("toolbar", { name: "1 session selected" })
    ).toBeNull();
    fireEvent.click(
      renderedRows[2]?.querySelector('[data-column-id="status"]') as Element,
      { shiftKey: true }
    );
    for (const row of renderedRows.slice(0, 3)) {
      expect(row).toHaveAttribute("aria-selected", "true");
    }
    expect(renderedRows[3]).toHaveAttribute("aria-selected", "false");

    const bulkActions = screen.getByRole("toolbar", {
      name: "3 sessions selected",
    });
    expect(bulkActions).toBeVisible();
    await userEvent.click(
      within(bulkActions).getByRole("button", { name: "Favorite sessions" })
    );
    expect(favoriteChange).toHaveBeenCalledWith(rows[0], true);
    expect(favoriteChange).toHaveBeenCalledWith(rows[1], true);
    expect(favoriteChange).toHaveBeenCalledWith(rows[2], true);
    expect(
      screen.queryByRole("toolbar", { name: "3 sessions selected" })
    ).toBeNull();

    fireEvent.click(
      renderedRows[0]?.querySelector('[data-column-id="status"]') as Element
    );
    fireEvent.click(
      renderedRows[2]?.querySelector('[data-column-id="status"]') as Element,
      { shiftKey: true }
    );
    const removeBulkActions = screen.getByRole("toolbar", {
      name: "3 sessions selected",
    });
    expect(
      within(removeBulkActions).getByRole("button", {
        name: "Remove sessions from favorites",
      })
    ).toBeVisible();
    await userEvent.click(
      within(removeBulkActions).getByRole("button", {
        name: "Clear selection",
      })
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Remove Interactive 1 from favorites",
      })
    );
    expect(favoriteChange).toHaveBeenCalledWith(rows[0], false);

    await userEvent.click(screen.getByRole("button", { name: "Add field" }));
    const addFieldDialog = screen.getByRole("dialog");
    expect(
      within(addFieldDialog).getByRole("heading", { name: "Add field" })
    ).toBeVisible();
    expect(
      within(addFieldDialog).getByRole("textbox", {
        name: FIELD_TITLE_PATTERN,
      })
    ).toBeVisible();
    expect(
      within(addFieldDialog).getByRole("combobox", { name: "Field type" })
    ).toBeVisible();
    expect(within(addFieldDialog).queryByText("Applies to")).toBeNull();
    expect(within(addFieldDialog).queryByText("Display options")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    await userEvent.click(
      screen.getByRole("button", { name: "Stage column options" })
    );
    expect(
      screen.getByRole("menuitem", { name: "Sort ascending" })
    ).toBeVisible();
    const filterMenu = screen.getByRole("menuitem", { name: "Filter" });
    await userEvent.hover(filterMenu);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Grid ready" })
    );
    // DATA rows only — the chrome header row carries `data-grid-row-id` too
    // since ISS-10245 made `navigableHeaderCells` unconditional.
    await waitFor(() =>
      expect(
        [
          ...container.querySelectorAll<HTMLElement>("[data-grid-row-id]"),
        ].filter((row) => !isGridChromeRowId(row.dataset.gridRowId ?? ""))
      ).toHaveLength(1)
    );
  }, 20_000);

  it("keeps selection available in compact narrow-list mode", async () => {
    const createField = vi.fn(() => TEST_CUSTOM_FIELD);
    const favoriteChange = vi.fn();
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...ROW,
      id: `card-${index + 1}`,
      name: `Card ${index + 1}`,
    }));
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        <InteractiveContractHarness
          createField={createField}
          favoriteChange={favoriteChange}
          mode="compact"
          rows={rows}
        />
      </FeatureFlagAdapterProvider>
    );
    const narrowRows = rows.map((row) => {
      const element = container.querySelector<HTMLElement>(
        `[data-grid-row-id="${row.id}"]`
      );
      if (!element) {
        throw new Error(`Missing narrow row ${row.id}`);
      }
      return element;
    });
    expect(narrowRows).toHaveLength(3);
    expect(container.querySelectorAll('[role="columnheader"]')).toHaveLength(1);
    expect(container.querySelector('[role="columnheader"]')).toHaveTextContent(
      "Name"
    );
    const favoriteTarget = screen
      .getByRole("button", { name: CARD_ONE_FAVORITE_PATTERN })
      .closest<HTMLElement>(".h-11.w-9");
    expect(favoriteTarget).toBeInTheDocument();

    fireEvent.click(narrowRows[0]);
    fireEvent.click(narrowRows[2], { shiftKey: true });
    for (const row of narrowRows) {
      expect(row).toHaveAttribute("aria-selected", "true");
    }
    await userEvent.click(screen.getByRole("button", { name: "View" }));
    // ISS-13007: the folded View menu offers Add field as Documents' does.
    expect(screen.getByRole("menuitem", { name: "Add field" })).toBeTruthy();
  }, 20_000);
});

function InteractiveContractHarness({
  createField,
  favoriteChange,
  mode = "expanded",
  rows,
}: {
  createField?: () => CustomFieldWithOptions;
  favoriteChange: (row: SessionTableRow, favorited: boolean) => void;
  mode?: "compact" | "expanded";
  rows: SessionTableRow[];
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(
    () => new Set([rows[0]?.id ?? ""])
  );
  return (
    <SessionsListSurfaceV2
      customFields={{
        fields: [TEST_CUSTOM_FIELD, TEST_FILTER_FIELD],
        onCreateField: createField,
        valuesBySessionId: new Map([
          [rows[0]?.id ?? "", [TEST_CUSTOM_VALUE, TEST_FILTER_VALUE]],
        ]),
      }}
      favorites={{
        favoriteIds,
        onBulkChange: (changedRows, favorited) => {
          for (const row of changedRows) {
            favoriteChange(row, favorited);
          }
          setFavoriteIds((current) =>
            setMembershipForRows(current, changedRows, favorited)
          );
        },
        onChange: (row, favorited) => {
          favoriteChange(row, favorited);
          setFavoriteIds((current) =>
            setMembership(current, row.id, favorited)
          );
        },
      }}
      mode={mode}
      rows={rows}
      selection={{ onChange: setSelectedIds, selectedIds }}
      usage={undefined}
    />
  );
}

function setMembership(
  current: ReadonlySet<string>,
  id: string,
  included: boolean
): ReadonlySet<string> {
  const next = new Set(current);
  if (included) {
    next.add(id);
  } else {
    next.delete(id);
  }
  return next;
}

function setMembershipForRows(
  current: ReadonlySet<string>,
  rows: readonly SessionTableRow[],
  included: boolean
): ReadonlySet<string> {
  let next = current;
  for (const row of rows) {
    next = setMembership(next, row.id, included);
  }
  return next;
}

const TEST_CUSTOM_FIELD: CustomFieldWithOptions = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  createdById: "user-1",
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  description: null,
  entityTypes: [CustomFieldEntityType.Session],
  enumOptions: [],
  fieldType: CustomFieldType.Text,
  id: "summary",
  isGlobalToOrg: false,
  isSearchable: true,
  isSortable: true,
  name: "Summary",
  numberFormat: NumberFormat.None,
  organizationId: "org-1",
  precision: null,
  referenceTargetSources: [],
  showInTable: true,
  updatedAt: new Date("2026-08-25T12:00:00.000Z"),
};

const TEST_CUSTOM_VALUE: CustomFieldValueDetail = {
  customFieldId: TEST_CUSTOM_FIELD.id,
  dateValue: null,
  displayValue: "Grid ready",
  entityId: "interactive-1",
  enumValue: null,
  fieldType: CustomFieldType.Text,
  id: "value-1",
  multiEnumValues: [],
  name: TEST_CUSTOM_FIELD.name,
  numberValue: null,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: "Grid ready",
};

const TEST_FILTER_FIELD: CustomFieldWithOptions = {
  ...TEST_CUSTOM_FIELD,
  enumOptions: [
    {
      color: "#64748b",
      customFieldId: "stage",
      enabled: true,
      id: "stage-grid-ready",
      name: "Grid ready",
      sortOrder: 0,
    },
  ],
  fieldType: CustomFieldType.Enum,
  id: "stage",
  name: "Stage",
};

const TEST_FILTER_VALUE: CustomFieldValueDetail = {
  ...TEST_CUSTOM_VALUE,
  customFieldId: TEST_FILTER_FIELD.id,
  enumValue: TEST_FILTER_FIELD.enumOptions[0] ?? null,
  fieldType: CustomFieldType.Enum,
  id: "value-stage-1",
  name: TEST_FILTER_FIELD.name,
  textValue: null,
};
