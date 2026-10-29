/**
 * Behavior tests for the list-surface demo paths the toolbar UI cannot reach:
 * the controller's `clearCategoryFilter` (the demo's `activeChips` is empty,
 * so no chip ever calls it) and grouping on a field no row carries.
 *
 * The controller is captured through a pass-through mock of the v2
 * `FilterPopover` and driven directly.
 */
import type {
  TableFiltersController,
  TableFiltersViewModel,
} from "@repo/design-system/components/ui/table-filters-v2";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { composeStory } from "@storybook/react";
import { act } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_ROWS,
  SessionStatus,
} from "../stories/grid-table-toolbar-demo/fixtures";
import { ListSurfaceDemo } from "../stories/grid-table-toolbar-demo/list-surface-demo";

const captured: {
  controller: TableFiltersController | null;
  viewModel: TableFiltersViewModel | null;
} = {
  controller: null,
  viewModel: null,
};

vi.mock(
  "@repo/design-system/components/ui/filter-popover-v2",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/design-system/components/ui/filter-popover-v2")
      >();
    function CapturingFilterPopover(
      props: ComponentProps<typeof actual.FilterPopover>
    ) {
      captured.controller = props.controller;
      captured.viewModel = props.viewModel;
      return <actual.FilterPopover {...props} />;
    }
    return { ...actual, FilterPopover: CapturingFilterPopover };
  }
);

/** `PAGE_SIZE` is 4, so an unfiltered first page holds four rows. */
const UNFILTERED_FIRST_PAGE = ["ses_7b91", "ses_7b74", "ses_7b58", "ses_7b40"];
const FAILED_ROW_IDS = SESSION_ROWS.filter(
  (row) => row.status === SessionStatus.Failed
).map((row) => row.id);
/** No row owned by this owner is Failed, so with both filters nothing renders. */
const OWNER_WITH_NO_FAILED_ROWS = "Ottilie Eastwick";
const OWNER_FACET_ID = "owner";
/** `partition` buckets a row with no value for the field under this key. */
const MISSING_FIELD_GROUP_LABEL = "—";

async function renderDemo(props: ComponentProps<typeof ListSurfaceDemo> = {}) {
  const Story = composeStory(
    { render: () => <ListSurfaceDemo {...props} /> },
    { title: "Test/ListSurfaceDemoController", component: ListSurfaceDemo }
  );
  await Story.run();
}

function controller(): TableFiltersController {
  if (!captured.controller) {
    throw new Error("FilterPopover never rendered");
  }
  return captured.controller;
}

function ownerFacet() {
  const facet = captured.viewModel?.facetGroups?.find(
    (group) => group.id === OWNER_FACET_ID
  );
  if (!facet) {
    throw new Error("owner facet never rendered");
  }
  return facet;
}

function renderedRowIds() {
  return Array.from(document.querySelectorAll("[data-grid-row-id]")).map(
    (row) => row.getAttribute("data-grid-row-id")
  );
}

afterEach(() => {
  captured.controller = null;
  captured.viewModel = null;
});

describe("ListSurfaceDemo filter controller", () => {
  it("clearCategoryFilter('status') drops the status filter", async () => {
    await renderDemo({ initialStatuses: [SessionStatus.Failed] });
    expect(renderedRowIds()).toEqual(FAILED_ROW_IDS);
    act(() => controller().clearCategoryFilter("status"));
    expect(controller().filters.statuses).toEqual([]);
    expect(renderedRowIds()).toEqual(UNFILTERED_FIRST_PAGE);
  });

  it("clearCategoryFilter('assignee') clears the owner filter and keeps status", async () => {
    await renderDemo({ initialStatuses: [SessionStatus.Failed] });
    act(() => ownerFacet().onToggle(OWNER_WITH_NO_FAILED_ROWS));
    expect(ownerFacet().selectedValues).toEqual([OWNER_WITH_NO_FAILED_ROWS]);
    expect(renderedRowIds()).toEqual([]);
    act(() => controller().clearCategoryFilter("assignee"));
    expect(ownerFacet().selectedValues).toEqual([]);
    expect(controller().filters.statuses).toEqual([SessionStatus.Failed]);
    expect(renderedRowIds()).toEqual(FAILED_ROW_IDS);
  });

  it("clearCategoryFilter for another category changes nothing", async () => {
    await renderDemo({ initialStatuses: [SessionStatus.Failed] });
    act(() => controller().clearCategoryFilter("priority"));
    expect(controller().filters.statuses).toEqual([SessionStatus.Failed]);
    expect(renderedRowIds()).toEqual(FAILED_ROW_IDS);
  });
});

describe("ListSurfaceDemo grouping on a field rows lack", () => {
  it("renders no missing-value group when ungrouped", async () => {
    await renderDemo();
    expect(document.body.textContent).not.toContain(MISSING_FIELD_GROUP_LABEL);
  });

  it("buckets every row under the missing-value group", async () => {
    await renderDemo({
      initialGrouping: {
        ...EMPTY_TABLE_GROUPING,
        primary: { ...EMPTY_TABLE_GROUPING.primary, fieldId: "notAField" },
      },
    });
    expect(document.body.textContent).toContain(MISSING_FIELD_GROUP_LABEL);
    expect(renderedRowIds()).toEqual(SESSION_ROWS.map((row) => row.id));
  });
});
