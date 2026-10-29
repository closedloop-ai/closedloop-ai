import { BranchDataState, BranchKpiState } from "@repo/api/src/types/branch";
import {
  type BranchListMetricValue,
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY } from "@repo/api/src/types/branches-linked-session-chips-flag";
import { BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY } from "@repo/api/src/types/branches-list-column-controls-flag";
import {
  PROVENANCE_RELATIONSHIP_KIND_LABELS,
  ProvenanceRelationshipKind,
} from "@repo/api/src/types/provenance-relationship";
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  kpi,
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import { BranchesListSurfaceV2 } from "@repo/app/branches/components/branches-list-surface-v2";
import type { BranchesToolbarProps } from "@repo/app/branches/components/branches-toolbar-model";
import { useBranchFilterState } from "@repo/app/branches/hooks/use-branch-filter-state";
import { useBranchViewState } from "@repo/app/branches/hooks/use-branch-view-state";
import { BranchCohortNoticeKind } from "@repo/app/branches/lib/branch-cohort-transparency";
import {
  BRANCH_SESSIONS_COLUMN_ID,
  branchColumnLabel,
} from "@repo/app/branches/lib/branch-column-view-model";
import { branchFiltersAreActive } from "@repo/app/branches/lib/branch-list-state";
import {
  type BranchRow,
  type BranchRowSession,
  BranchRowStatus,
} from "@repo/app/branches/lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "@repo/app/branches/lib/branch-sample-data";
import {
  type BranchSortDir,
  type BranchSortKey,
  sortBranchRows,
} from "@repo/app/branches/lib/branch-sort-group";
// ISS-10249: My Tasks owns the recency window's "Show all time" wording.
import { MY_TASKS_RECENCY_SHOW_ALL_LABEL } from "@repo/app/my-tasks/lib/my-tasks-recency-window";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import { isGridChromeRowId } from "@repo/design-system/lib/grid-table-v2-chrome-rows";
import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { useMemo, useState } from "react";
import { expect, screen, userEvent, within } from "storybook/test";

// The header cell addressed by COLUMN ID, not accessible name (ISS-6065): the
// v2 grid puts a resize handle and a column-options button inside the cell,
// and before ISS-11837 their names were folded into the cell's name in a real
// browser. The column id does not depend on the header's naming, which is what
// keeps the absence assertion below able to fail.
const REPOSITORY_HEADER_SELECTOR =
  '[role="columnheader"][data-column-id="repo"]';
const STORY_ROW_COUNT = 36;
const STORY_NOW_MS = Date.now();
const HOUR_MS = 60 * 60 * 1000;

const STORY_ROWS = makeStoryRows();
const SESSIONS_HEADER_SELECTOR = `[role="columnheader"][data-column-id="${BRANCH_SESSIONS_COLUMN_ID}"]`;
const CONTRIBUTED_LABEL =
  PROVENANCE_RELATIONSHIP_KIND_LABELS[ProvenanceRelationshipKind.Contribution];
const SINGLE_CHIP_NAME = new RegExp(
  `SES-9100 · Riley Demo · Active · ${CONTRIBUTED_LABEL}`
);
const RELATED_CHIP_TITLE = new RegExp(
  `SES-9101 · Avery Example · Active · ${CONTRIBUTED_LABEL}`
);
const SINGLE_ARTIFACT_ID = "0d9c7b5a-3e1f-4a2b-8c6d-4e2f0a8b6c4d";
const CHIPS_ARTIFACT_ID = "5c1c0a2e-6d1a-4f5b-9c3e-8a1d2f3b4c5d";
const NONE_ARTIFACT_ID = "8f2e4d6c-1a3b-4c5d-9e7f-0a1b2c3d4e5f";
const CAPPED_ARTIFACT_ID = "2b7a9c4e-6d8f-4a1b-8c3d-5e7f9a1b3c5d";
const CAPPED_OVERFLOW_PILL = /^\+[23]$/;
const LOCAL_ROW_COUNT_CHIP_NAME = /linked sessions for agent\/local-only/;
const RELATED_SESSIONS_ROWS = makeRelatedSessionsRows();
const EMPTY_ROW_SELECTOR = `[data-grid-row-id="${emptyRelatedSessionsRow().id}"]`;
// Selected by the capped row's own id, not its position: the two-chip row's
// pill also reads `+2` under jsdom, so a positional selector that drifted onto
// it would pass without ever looking at the capped row.
const CAPPED_ROW_SELECTOR = `[data-grid-row-id="${cappedRelatedSessionsRow().id}"]`;
const STORY_ANALYTICS = makeBranchAnalytics({
  activeBranchCount: kpi(BranchKpiState.Available, 19),
  canonicalMetrics: makeBranchListMetrics({
    period: BranchMetricPeriod.ThirtyDays,
    label: BranchMetricComparisonLabel.MonthOverMonth,
    cohortSize: STORY_ROW_COUNT,
    lastActiveAt: {
      state: BranchMetricAvailability.Complete,
      value: new Date(STORY_NOW_MS).toISOString(),
    },
    activeBranches: completeMetric(19),
    aiSpendUsd: completeMetric(1862),
    // The field the ratio card selects since ISS-10636; the superseded
    // `locPerDollar` reaches no tile, so a story setting only that one
    // would render an absent ratio.
    canonicalLocPerDollar: completeMetric(42.7),
    medianPrSize: completeMetric(384),
    mergeRatePct: completeMetric(73),
  }),
});

const meta = {
  title: "Composites v1.0/Branches/Branches List Surface V2",
  component: BranchesListSurfaceV2Story,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof BranchesListSurfaceV2Story>;

// No controls: these states render one fixed Branches payload and saved view.

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <BranchesListSurfaceV2Story />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByRole("button", { name: "Filter" })).toBeVisible();
    // The measured wide slot mounts Options alone; compact View appears only
    // when this surface's content box crosses the card breakpoint.
    const optionsTriggers = canvas.getAllByRole("button", {
      hidden: true,
      name: "Options",
    });
    await expect(optionsTriggers).toHaveLength(1);
    await expect(canvas.queryByRole("button", { name: "View" })).toBeNull();
    const visibleOptions = canvas.getByRole("button", { name: "Options" });
    await expect(
      canvas.getByRole("combobox", { name: "Rows per page" })
    ).toHaveTextContent("25 / page");
    await expect(canvas.queryByRole("searchbox")).toBeNull();
    // En dash, which is what BOTH production Branches hosts have always
    // rendered. This story used to build its OWN readout with an ASCII hyphen —
    // a sixth expression of the sentence, and the one this assertion was pinned
    // to. The surface states it now, so the story reads the shipped glyph.
    await expect(canvas.getByRole("status")).toHaveTextContent("1–25 of 36");
    await expect(dataGridRows(canvasElement)).toHaveLength(25);
    await expect(canvas.getByText("agent/branches-v2-0")).toBeVisible();
    await expect(canvas.getByText("agent/branches-v2-1")).toBeVisible();

    // Drive the menu rather than assert it renders: the story owns the real
    // `useBranchViewState`, so hiding a column has to reach the TABLE for this
    // to pass, and "Reset view" has to bring it back. That is what the v1
    // "Columns" assertion used to stand for, on the control that replaced it.
    await expect(
      canvasElement.querySelector(REPOSITORY_HEADER_SELECTOR)
    ).not.toBeNull();
    await userEvent.click(visibleOptions);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Repository" })
    );
    // Close the menu BEFORE reading the table. Radix's dropdown is modal and
    // `aria-hidden`s the page behind it, so a columnheader query taken while it
    // is open returns null whether or not the toggle ever reached the table —
    // the assertion below would pass against a toolbar wired to nothing.
    await userEvent.keyboard("{Escape}");
    await expect(
      canvasElement.querySelector(REPOSITORY_HEADER_SELECTOR)
    ).toBeNull();
    await userEvent.click(visibleOptions);
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Reset view" })
    );
    await expect(
      canvasElement.querySelector(REPOSITORY_HEADER_SELECTOR)
    ).not.toBeNull();
  },
};

/** Compact state: flag-off keeps captured-main cards below the measured boundary. */
export const CompactWidth: Story = {
  decorators: [CompactWidthDecorator],
  render: () => <BranchesListSurfaceV2Story />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("branches-measured-width-host");
    await expect(host).toHaveAttribute(
      "style",
      `width: ${CARD_FALLBACK_BREAKPOINT - 1}px;`
    );
    if (!hasBrowserLayout(host)) {
      return;
    }

    await expect(canvas.queryByRole("grid")).toBeNull();
    const firstCardFields = canvasElement.querySelector("dl");
    if (!firstCardFields) {
      throw new Error("compact branch card fields did not render");
    }
    await expect(within(firstCardFields).getByText("Repository")).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "agent/branches-v2-0" })
    ).toHaveAttribute("href", "/branches/branches-v2-0");
    await expect(
      within(firstCardFields).getByText("Collaborators")
    ).toBeVisible();
    await expect(
      within(firstCardFields).getByText("Linked sessions")
    ).toBeVisible();
  },
};

/** The exact 768px boundary keeps every selected field in a scrolling grid. */
export const ExpandedAtBoundary: Story = {
  decorators: [ExpandedWidthDecorator],
  render: () => <BranchesListSurfaceV2Story />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("branches-measured-width-host");
    await expect(host).toHaveStyle({ width: `${CARD_FALLBACK_BREAKPOINT}px` });
    if (!hasBrowserLayout(host)) {
      return;
    }
    await expect(canvas.getByRole("grid")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "View" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Sort" })).toBeNull();
    await expect(
      canvasElement.querySelector(REPOSITORY_HEADER_SELECTOR)
    ).not.toBeNull();
  },
};

/** Grouped narrow rows keep one band open while another is collapsed. */
export const CompactGrouped: Story = {
  decorators: [CompactWidthDecorator],
  parameters: {
    appCore: {
      enabledFlags: [BRANCHES_LIST_COLUMN_CONTROLS_FLAG_KEY],
    },
  },
  render: () => <BranchesListSurfaceV2Story />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("branches-measured-width-host");
    await expect(host).toHaveAttribute(
      "style",
      `width: ${CARD_FALLBACK_BREAKPOINT - 1}px;`
    );
    if (!hasBrowserLayout(host)) {
      return;
    }

    await userEvent.click(canvas.getByRole("button", { name: "View" }));
    await userEvent.click(screen.getByText("Group by", { exact: true }));
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: "Repository" })
    );

    const symphonyGroup = canvas.getByRole("button", {
      expanded: true,
      name: "closedloop-ai",
    });
    await expect(
      canvas.getByRole("button", {
        expanded: true,
        name: "closedloop-web",
      })
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "agent/branches-v2-0" })
    ).toBeVisible();

    await userEvent.click(symphonyGroup);

    await expect(
      canvas.getByRole("button", {
        expanded: false,
        name: "closedloop-ai",
      })
    ).toBeVisible();
    await expect(
      canvas.queryByRole("link", { name: "agent/branches-v2-0" })
    ).toBeNull();
  },
};

/** Hidden Status is not promoted, and another hidden body field stays absent. */
export const CompactHiddenColumns: Story = {
  decorators: [CompactWidthDecorator],
  render: () => <BranchesListSurfaceV2Story />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("branches-measured-width-host");
    await expect(host).toHaveAttribute(
      "style",
      `width: ${CARD_FALLBACK_BREAKPOINT - 1}px;`
    );
    if (!hasBrowserLayout(host)) {
      return;
    }
    const options = () => {
      return canvas.getByRole("button", { name: "View" });
    };

    await userEvent.click(options());
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Status" })
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Repository" }));
    await userEvent.keyboard("{Escape}");

    await expect(canvas.queryByRole("grid")).toBeNull();
    await expect(canvasElement.querySelector("dl")).not.toBeNull();
    await expect(canvasElement.querySelector("dt")).not.toBeNull();
    await expect(
      [...canvasElement.querySelectorAll("dt")].some(
        (field) => field.textContent === "Repository"
      )
    ).toBe(false);
    await expect(canvas.queryByText("Open", { exact: true })).toBeNull();
  },
};

export const Loading: Story = {
  render: () => <BranchesListSurfaceV2Story isPending />,
};

export const Unavailable: Story = {
  render: () => <BranchesListSurfaceV2Story isError rows={[]} />,
};

export const NoBranches: Story = {
  render: () => <BranchesListSurfaceV2Story rows={[]} />,
  // This mount owns the real `useBranchViewState`, which starts on the bounded
  // default window — a NARROWING — so zero rows here is honestly "none in this
  // window", and the story would otherwise be a second copy of `NoMatches`
  // under a name promising the genuine zero. Reach the genuine zero the way a
  // reader does: widen the window through the shipped control, which also pins
  // that the range and the empty state stay in agreement.
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByText("No matching branches")).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: "All time" }));
    await expect(canvas.getByText("No branches yet")).toBeVisible();
    await expect(canvas.queryByText("No matching branches")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: MY_TASKS_RECENCY_SHOW_ALL_LABEL })
    ).toBeNull();
  },
};

export const NoMatches: Story = {
  render: () => <BranchesListSurfaceV2Story forceNoMatches />,
};

/**
 * ISS-10816 — the `sessions` column with canonical Wrote membership chips ON:
 * one member, several members, an empty population, a description-capped `+N`,
 * and a local row whose producer can state only the count.
 */
export const RelatedSessions: Story = {
  parameters: {
    appCore: {
      enabledFlags: [BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY],
    },
  },
  render: () => <BranchesListSurfaceV2Story rows={RELATED_SESSIONS_ROWS} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvasElement.querySelector(SESSIONS_HEADER_SELECTOR)
    ).toHaveTextContent(branchColumnLabel(BRANCH_SESSIONS_COLUMN_ID));
    await expect(
      await canvas.findByRole("link", { name: SINGLE_CHIP_NAME })
    ).toHaveAttribute("href", "/sessions/SES-9100");
    await expect(
      canvas.getAllByTitle(RELATED_CHIP_TITLE).length
    ).toBeGreaterThan(0);
    const emptyRow =
      canvasElement.querySelector<HTMLElement>(EMPTY_ROW_SELECTOR);
    if (!emptyRow) {
      throw new Error("the empty Linked sessions row did not render");
    }
    const emptyValue = emptyRow.querySelector('[data-slot="grid-empty-value"]');
    await expect(emptyValue).toBeInTheDocument();
    await expect(emptyValue).not.toHaveAttribute("title");
    // The capped row delivered one chip and withheld two. In a browser the
    // chip fits beside the pill and the pill reads `+2`; under jsdom every
    // width is 0, so the chip collapses into it and it reads `+3`. Either way
    // the withheld two are counted, which is the claim.
    const cappedRow =
      canvasElement.querySelector<HTMLElement>(CAPPED_ROW_SELECTOR);
    if (!cappedRow) {
      throw new Error("the server-capped row did not render");
    }
    await expect(
      within(cappedRow).getByText(CAPPED_OVERFLOW_PILL)
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("link", {
        name: LOCAL_ROW_COUNT_CHIP_NAME,
      })
    ).toBeInTheDocument();
  },
};

function BranchesListSurfaceV2Story({
  forceNoMatches = false,
  isError = false,
  isPending = false,
  rows = STORY_ROWS,
}: {
  forceNoMatches?: boolean;
  isError?: boolean;
  isPending?: boolean;
  rows?: BranchRow[];
}) {
  const [pageSize, setPageSizeState] = useState(25);
  const {
    dateRange,
    columnOrder,
    columnWidths,
    hiddenSummaryCards,
    resetView,
    setColumnOrder,
    setColumnWidth,
    setDateRange,
    setSort,
    sortDir,
    sortKey,
    toggleColumn,
    toggleSummaryCard,
    visibleColumns,
  } = useBranchViewState(undefined, true);
  const sortedRows = useMemo(
    () => sortBranchRows(rows, sortKey, sortDir),
    [rows, sortKey, sortDir]
  );
  const {
    filters,
    filteredRows,
    handleFiltersChange,
    page,
    pagedRows,
    setPage,
    total,
    totalPages,
  } = useBranchFilterState(sortedRows, pageSize, undefined, true, STORY_NOW_MS);
  const visibleRows = forceNoMatches ? [] : pagedRows;
  const visibleTotal = forceNoMatches ? 0 : total;
  const toolbarProps: BranchesToolbarProps = {
    approved: true,
    dateRange,
    filters,
    now: STORY_NOW_MS,
    onDateRangeChange: setDateRange,
    onFiltersChange: handleFiltersChange,
    hiddenSummaryCards,
    onResetView: resetView,
    onToggleColumn: toggleColumn,
    onToggleSummaryCard: toggleSummaryCard,
    rows: filteredRows,
    visibleColumns,
  };
  const handlePageSizeChange = (nextPageSize: number) => {
    setPageSizeState(nextPageSize);
    setPage(0);
  };
  const handleSort = (column: string, direction: SortDirection) =>
    setSort(column as BranchSortKey, direction as BranchSortDir);
  const summaryBandProps = {
    cohortNotice: { kind: BranchCohortNoticeKind.Hidden, total: visibleTotal },
    comparisonSuppressedByFilter: false,
    onSummaryRetry: () => undefined,
    summaryAnalyticsErrored: false,
    summaryCards: STORY_ANALYTICS,
    summaryCardsErrored: false,
    summaryCardsPending: false,
    summaryCardsReloading: false,
  };

  return (
    <div className="flex h-screen min-h-[720px] flex-col bg-background">
      <BranchesListSurfaceV2
        allRows={filteredRows}
        className="min-h-0 flex-1 overflow-hidden"
        columnOrder={columnOrder}
        columnWidths={columnWidths}
        getBranchHref={(item) => `/branches/${item.id}`}
        getSessionHref={(session) => `/sessions/${session.navigableRef}`}
        getSessionsHref={(item) => `/sessions?branch=${item.id}`}
        hasActiveFilters={branchFiltersAreActive(filters)}
        hasWindow={dateRange !== "all"}
        historyListTestId="branches-v2-story-history-list"
        includePriorityColumn
        isError={isError}
        isPending={isPending}
        isPlaceholderData={false}
        items={visibleRows}
        onColumnOrderChange={setColumnOrder}
        onColumnWidthChange={setColumnWidth}
        onPageChange={setPage}
        onPageSizeChange={handlePageSizeChange}
        onRetry={() => undefined}
        onShowAllTime={() => setDateRange("all")}
        onSort={handleSort}
        page={page}
        pageSize={pageSize}
        sortBy={sortKey}
        sortDir={sortDir}
        {...summaryBandProps}
        tableScrollTestId="branches-v2-story-scroll-container"
        toolbar={toolbarProps}
        total={visibleTotal}
        totalPages={totalPages}
        visibleColumns={visibleColumns}
      />
    </div>
  );
}

function makeStoryRows(): BranchRow[] {
  return Array.from({ length: STORY_ROW_COUNT }, (_, index) => {
    const source = BRANCH_SAMPLE_ROWS[index % BRANCH_SAMPLE_ROWS.length]!;
    const prNumber = source.prNumber === null ? null : source.prNumber + index;
    return {
      ...source,
      id: `branches-v2-${index}`,
      branchName: `agent/branches-v2-${index}`,
      dataState: index === 1 ? BranchDataState.AwaitingSync : source.dataState,
      lastActivityAt: new Date(STORY_NOW_MS - index * HOUR_MS).toISOString(),
      lastActivityLabel: index === 0 ? "just now" : `${index}h ago`,
      ownerKey: source.ownerKey ?? `github:${source.owner.toLowerCase()}`,
      prNumber,
      prTitle: prNumber === null ? null : source.prTitle,
      prUrl:
        prNumber === null
          ? null
          : `https://github.com/closedloop-ai/closedloop-ai/pull/${prNumber}`,
      repo:
        index % 3 === 0
          ? "closedloop-ai/closedloop-ai"
          : "closedloop-ai/closedloop-web",
      status: index % 5 === 0 ? BranchRowStatus.Review : source.status,
    };
  });
}

/**
 * Five rows, one per state the flag-on cell distinguishes: a single chip, two
 * chips, the empty sentinel, a server-capped `+N`, and a local row with no
 * artifact id.
 */
function makeRelatedSessionsRows(): BranchRow[] {
  const [single, chips, none, capped, local] = makeStoryRows();
  if (!(single && chips && none && capped && local)) {
    throw new Error("the sample rows are shorter than this story needs");
  }
  return [
    {
      ...single,
      artifactId: SINGLE_ARTIFACT_ID,
      sessionCount: 1,
      sessions: [
        storySession("9100", "Riley Demo", DISPLAYED_SESSION_STATUS.ACTIVE, 1),
      ],
    },
    {
      ...chips,
      artifactId: CHIPS_ARTIFACT_ID,
      sessionCount: 2,
      sessions: [
        storySession(
          "9101",
          "Avery Example",
          DISPLAYED_SESSION_STATUS.ACTIVE,
          3
        ),
        storySession(
          "9102",
          "Morgan Sample",
          DISPLAYED_SESSION_STATUS.INACTIVE,
          26
        ),
      ],
    },
    {
      ...none,
      artifactId: NONE_ARTIFACT_ID,
      sessionCount: 0,
      sessions: [],
    },
    {
      ...capped,
      artifactId: CAPPED_ARTIFACT_ID,
      sessionCount: 3,
      sessions: [
        storySession("9103", null, DISPLAYED_SESSION_STATUS.INACTIVE, 50),
      ],
    },
    {
      ...local,
      artifactId: undefined,
      branchName: "agent/local-only",
      sessionCount: 4,
    },
  ];
}

function cappedRelatedSessionsRow(): BranchRow {
  const capped = RELATED_SESSIONS_ROWS.find(
    (row) => row.artifactId === CAPPED_ARTIFACT_ID
  );
  if (!capped) {
    throw new Error("the story rows carry no server-capped row");
  }
  return capped;
}

function emptyRelatedSessionsRow(): BranchRow {
  const empty = RELATED_SESSIONS_ROWS.find(
    (row) => row.artifactId === NONE_ARTIFACT_ID
  );
  if (!empty) {
    throw new Error("the story rows carry no empty Linked sessions row");
  }
  return empty;
}

function completeMetric(value: number): BranchListMetricValue {
  return {
    current: {
      state: BranchMetricAvailability.Complete,
      value,
    },
  };
}

/**
 * The DATA rows of a rendered grid, excluding chrome.
 *
 * ISS-10245 made `navigableHeaderCells` unconditional, so `GridTableV2`'s chrome
 * header row carries `data-grid-row-id` alongside the real rows — as `rows[0]`
 * it has no data cells to click, and in a count it reads as one row too many.
 */
function dataGridRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("[data-grid-row-id]")].filter(
    (row) => !isGridChromeRowId(row.dataset.gridRowId ?? "")
  );
}

function storySession(
  suffix: string,
  ownerName: string | null,
  status: BranchRowSession["status"],
  hoursAgo: number
): BranchRowSession {
  return {
    id: `session-${suffix}`,
    navigableRef: `SES-${suffix}`,
    occurredAt: new Date(STORY_NOW_MS - hoursAgo * HOUR_MS).toISOString(),
    ownerName,
    relationshipLabel: CONTRIBUTED_LABEL,
    slug: `SES-${suffix}`,
    status,
  };
}

function CompactWidthDecorator(Story: Parameters<Decorator>[0]) {
  return (
    <div
      className="max-w-full"
      data-testid="branches-measured-width-host"
      style={{ width: CARD_FALLBACK_BREAKPOINT - 1 }}
    >
      <Story />
    </div>
  );
}

function ExpandedWidthDecorator(Story: Parameters<Decorator>[0]) {
  return (
    <div
      data-testid="branches-measured-width-host"
      style={{ width: CARD_FALLBACK_BREAKPOINT }}
    >
      <Story />
    </div>
  );
}

function hasBrowserLayout(host: HTMLElement): boolean {
  return host.getBoundingClientRect().width > 0;
}
