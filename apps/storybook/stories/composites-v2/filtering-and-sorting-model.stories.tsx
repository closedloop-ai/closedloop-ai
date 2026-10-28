import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import {
  LIST_TOOLBAR_SEARCH_LABEL,
  LIST_TOOLBAR_SEARCH_PLACEHOLDER,
} from "@repo/app/shared/components/list-toolbar-copy";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  buildFacetOnlyFiltersViewModel,
  NOOP_TABLE_FILTERS_CONTROLLER,
} from "@repo/app/shared/lib/facet-filter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { FilterPopover } from "@repo/design-system/components/ui/filter-popover";
import type { FilterRangeGroup } from "@repo/design-system/components/ui/table-filters";
import {
  EMPTY_TABLE_GROUPING,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ListSurfaceDemo } from "./filtering-and-sorting-model/filtering-and-sorting-model-demo";
import {
  DEFAULT_VISIBLE_COLUMN_IDS,
  DEFAULT_VISIBLE_METRIC_KEYS,
} from "./filtering-and-sorting-model/fixtures";

const FILTER_BUTTON_PATTERN = /^Filter/;
const STATUS_ITEM_PATTERN = /^Status/;
const ACTIVE_STATUS_LABEL = SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE];
const ACTIVE_STATUS_CHIP_LABEL = `Status: ${ACTIVE_STATUS_LABEL}`;
const COST_ITEM_PATTERN = /^Cost/;
const UPDATED_ITEM_PATTERN = /^Updated/;
const SAVED_VIEW_GROUPING = {
  ...EMPTY_TABLE_GROUPING,
  primary: {
    fieldId: "status",
    order: TableGroupOrder.Ascending,
    showEmptyGroups: false,
  },
};
const SAVED_VIEW_COLUMNS = DEFAULT_VISIBLE_COLUMN_IDS.filter(
  (columnId) => columnId !== "repository"
);
const SAVED_VIEW_METRICS = [...DEFAULT_VISIBLE_METRIC_KEYS, "active"];

// The production toolbar renders the champions only with the ISS-12641 flag
// open; this entry documents the champion contract, so it opens the flag.
const withChampionControls: Decorator = (Story) => (
  <FeatureFlagAdapterProvider
    adapter={createStaticFeatureFlagAdapter({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    })}
  >
    <Story />
  </FeatureFlagAdapterProvider>
);

const meta = {
  title: "Composites/Shared/Artifact List/Filtering and Sorting Model",
  tags: ["stable"],
  decorators: [withChampionControls],
  parameters: { layout: "fullscreen", controls: { disable: true } },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// No controls: each story is a cross-component fixture contract.
export const Default: Story = {
  render: () => <ListSurfaceDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(globalThis.document.body);

    const filterTrigger = canvas.getByRole("button", {
      name: FILTER_BUTTON_PATTERN,
    });
    await expect(filterTrigger.querySelector("svg")).not.toBeNull();
    await userEvent.click(filterTrigger);
    const statusItem = await page.findByRole("menuitem", {
      name: STATUS_ITEM_PATTERN,
    });
    await expect(
      statusItem.querySelector("svg:not(.lucide-chevron-right)")
    ).toBeNull();
    await userEvent.click(statusItem);
    await userEvent.click(
      await page.findByRole("menuitem", { name: ACTIVE_STATUS_LABEL })
    );
    await userEvent.keyboard("{Escape}{Escape}");

    await expect(canvas.getByText(ACTIVE_STATUS_CHIP_LABEL)).toBeVisible();
    await userEvent.click(
      await canvas.findByRole("button", { name: "Clear filters" })
    );
    await expect(canvas.queryByText(ACTIVE_STATUS_CHIP_LABEL)).toBeNull();

    await userEvent.click(canvas.getByRole("radio", { name: "Last 7 days" }));
    await expect(metricValue(canvasElement, "Sessions")).toHaveTextContent("5");
  },
};

export const ActiveFilters: Story = {
  render: () => <ListSurfaceDemo initialStatuses={[SESSION_STATUS.ACTIVE]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(ACTIVE_STATUS_CHIP_LABEL)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", {
        name: `Remove ${ACTIVE_STATUS_CHIP_LABEL} filter`,
      })
    );
    await expect(canvas.queryByText(ACTIVE_STATUS_CHIP_LABEL)).toBeNull();
  },
};

export const Sorting: Story = {
  render: () => <ListSurfaceDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(globalThis.document.body);

    const sortTrigger = canvas.getByRole("button", { name: "Sort" });
    await expect(sortTrigger.querySelector("svg")).not.toBeNull();
    await userEvent.click(sortTrigger);
    const costItem = await page.findByRole("menuitem", {
      name: COST_ITEM_PATTERN,
    });
    await expect(costItem.querySelector("svg")).toBeNull();
    await userEvent.click(costItem);
    await expect(
      await canvas.findByRole("button", { name: "Sorted by Cost" })
    ).toBeVisible();
    await expect(renderedRowIds(canvasElement)).toEqual([
      "ses_7b12",
      "ses_7b74",
      "ses_7b58",
      "ses_7a98",
    ]);
    await userEvent.click(canvas.getByRole("button", { name: "Clear sort" }));
    await userEvent.click(canvas.getByRole("button", { name: "Sort" }));
    await userEvent.click(
      await page.findByRole("menuitem", { name: UPDATED_ITEM_PATTERN })
    );
    await expect(renderedRowIds(canvasElement)).toEqual([
      "ses_7a98",
      "ses_7b12",
      "ses_7b40",
      "ses_7b58",
    ]);
  },
};

export const ComposedToolbar: Story = {
  render: () => (
    <ListSurfaceDemo
      initialGrouping={SAVED_VIEW_GROUPING}
      initialSortBy="cost"
      initialStatuses={[SESSION_STATUS.ACTIVE]}
      initialVisibleColumnIds={SAVED_VIEW_COLUMNS}
      initialVisibleMetricKeys={SAVED_VIEW_METRICS}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(globalThis.document.body);
    await expect(
      canvas.getByRole("button", { name: FILTER_BUTTON_PATTERN })
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
    await expect(
      canvas.getAllByRole("button", { name: "Views" })[0]!
    ).toBeVisible();
    await expect(canvas.getByText(ACTIVE_STATUS_CHIP_LABEL)).toBeVisible();
    await expect(
      await canvas.findByRole("button", { name: "Sorted by Cost" })
    ).toBeVisible();
    await expect(
      await canvas.findByRole("button", { name: "Groups: 1" })
    ).toBeVisible();
    await expect(metricValue(canvasElement, "Active now")).toHaveTextContent(
      "2"
    );
    await expect(
      canvasElement.querySelector('[data-column-id="repository"]')
    ).toBeNull();

    await userEvent.click(canvas.getAllByRole("button", { name: "Views" })[0]!);
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Save current view" })
    );
    await userEvent.type(
      await page.findByRole("textbox", { name: "View name" }),
      "Active cost"
    );
    await userEvent.click(page.getByRole("button", { name: "Save view" }));

    await userEvent.click(
      await canvas.findByRole("button", { name: "Options" })
    );
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Reset view" })
    );

    await expect(canvas.queryByText(ACTIVE_STATUS_CHIP_LABEL)).toBeNull();
    await expect(
      await canvas.findByRole("button", { name: "Sort" })
    ).toBeVisible();
    await expect(
      await canvas.findByRole("button", { name: "Group" })
    ).toBeVisible();
    await expect(metricValue(canvasElement, "Active now")).toBeNull();
    await expect(
      canvasElement.querySelector('[data-column-id="repository"]')
    ).not.toBeNull();

    await userEvent.click(
      (await canvas.findAllByRole("button", { name: "Views" }))[0]!
    );
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Active cost" })
    );

    await expect(canvas.getByText(ACTIVE_STATUS_CHIP_LABEL)).toBeVisible();
    await expect(
      await canvas.findByRole("button", { name: "Sorted by Cost" })
    ).toBeVisible();
    await expect(
      await canvas.findByRole("button", { name: "Groups: 1" })
    ).toBeVisible();
    await expect(metricValue(canvasElement, "Active now")).toHaveTextContent(
      "2"
    );
    await expect(
      canvasElement.querySelector('[data-column-id="repository"]')
    ).toBeNull();
  },
};

export const RangeEscapeRecovery: Story = {
  render: () => <RangeEscapeDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(globalThis.document.body);

    await userEvent.click(
      canvas.getByRole("button", { name: FILTER_BUTTON_PATTERN })
    );
    const rangeTrigger = await page.findByRole("menuitem", {
      name: COST_ITEM_PATTERN,
    });
    // Open by keyboard: a pointer hover arms Radix's 100 ms hover-open timer,
    // which reopens the submenu if Escape lands before it fires.
    rangeTrigger.focus();
    await userEvent.keyboard("{ArrowRight}");
    const minInput = await page.findByLabelText("Min");
    await userEvent.click(minInput);
    await userEvent.type(minInput, "{Escape}", { skipClick: true });

    await waitFor(() => expect(page.queryByLabelText("Min")).toBeNull());
    await expect(rangeTrigger).toHaveFocus();
    await expect(rangeTrigger).toBeVisible();
  },
};

// No controls: each story is a cross-component fixture contract; the search,
// range and List/Board states are one named story each.
export const Search: Story = {
  render: () => <ListSurfaceDemo withSearch />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvas.getByRole("textbox", {
      name: LIST_TOOLBAR_SEARCH_LABEL,
    });
    await expect(search).toHaveAttribute(
      "placeholder",
      LIST_TOOLBAR_SEARCH_PLACEHOLDER
    );
    await userEvent.type(search, "token");
    await waitFor(() =>
      expect(renderedRowIds(canvasElement)).toEqual(["ses_7b74"])
    );
    await userEvent.clear(search);
    await waitFor(() => expect(renderedRowIds(canvasElement)).toHaveLength(4));
  },
};

export const WithoutRange: Story = {
  render: () => <ListSurfaceDemo withoutRange />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("radio", { name: "Last 7 days" })
    ).toBeNull();
    await expect(
      canvas.getByRole("button", { name: FILTER_BUTTON_PATTERN })
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Add field" })
    ).toBeVisible();
    await expect(
      canvas.getAllByRole("button", { name: "Views" })[0]!
    ).toBeVisible();
  },
};

export const ListAndBoard: Story = {
  render: () => <ListSurfaceDemo layout="list" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [listView] = canvas.getAllByRole("radio", { name: "List view" });
    const [boardView] = canvas.getAllByRole("radio", { name: "Board view" });
    await expect(listView).toBeChecked();
    await userEvent.click(boardView!);
    await expect(
      canvas.getAllByRole("radio", { name: "Board view" })[0]
    ).toBeChecked();
  },
};

export const Dark: Story = {
  render: () => <ListSurfaceDemo initialStatuses={[SESSION_STATUS.ACTIVE]} />,
  globals: { theme: "dark" },
};

export const Narrow: Story = {
  render: () => <ListSurfaceDemo initialStatuses={[SESSION_STATUS.ACTIVE]} />,
  globals: { viewport: { value: "390-844" } },
};

function RangeEscapeDemo() {
  const [min, setMin] = useState<number | undefined>(0);
  const [max, setMax] = useState<number | undefined>(50);
  const rangeGroup: FilterRangeGroup = {
    id: "cost",
    kind: "range",
    label: "Cost",
    max,
    min,
    onChange: (next) => {
      setMin(next.min);
      setMax(next.max);
    },
  };

  return (
    <div className="flex min-h-64 items-start p-6">
      <FilterPopover
        controller={NOOP_TABLE_FILTERS_CONTROLLER}
        viewModel={buildFacetOnlyFiltersViewModel([rangeGroup])}
      />
    </div>
  );
}

function renderedRowIds(canvasElement: HTMLElement): (string | null)[] {
  return Array.from(canvasElement.querySelectorAll("[data-grid-row-id]")).map(
    (row) => row.getAttribute("data-grid-row-id")
  );
}

function metricValue(
  canvasElement: HTMLElement,
  label: string
): Element | null {
  const description = Array.from(
    canvasElement.querySelectorAll('[data-slot="card-description"]')
  ).find((element) => element.textContent === label);
  return (
    description
      ?.closest('[data-slot="card"]')
      ?.querySelector('[data-slot="card-title"]') ?? null
  );
}
