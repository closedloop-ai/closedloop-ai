import { ArtifactStatusVocabulary } from "@repo/api/src/types/artifact-status-contract";
import { BranchDataState } from "@repo/api/src/types/branch";
import { BranchesListRolloutDecisionReason } from "@repo/api/src/types/branches-list-rollout";
import {
  GridviewRolloutDecisionOutcome,
  SharedAnalyticsComponent,
  Surface,
  SurfaceAnalyticsEvent,
} from "@repo/api/src/types/surface-analytics";
import { artifactStatusFullLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { artifactStatusView } from "@repo/app/shared/lib/artifact-status-adapter";
import {
  BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY,
  BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY,
  GRID_TABLE_V2_NUMBER_CELL_ALIGN_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { ROW_ACTIONS_COLUMN_ID } from "@repo/design-system/components/ui/grid-table";
import { TableBulkActionUndo } from "@repo/design-system/components/ui/table-bulk-actions";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SurfaceAnalyticsProvider } from "../../../shared/observability/surface-analytics-context";
import { type BranchRow, branchStatusEvidence } from "../../lib/branch-row";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import { BRANCH_ROW_A, BRANCH_ROW_B } from "./branches-list-rows.fixtures";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

const RE_OWNER_HEADER = /owner/i;
const RE_NAME_HEADER = /name/i;
/**
 * A column id a stored view can still carry and this build no longer declares.
 * Written out rather than imported: a fixture built from the live column set
 * could not name one, since every id it holds IS declared.
 */
const RETIRED_COLUMN_ID = "commentCount";
/** The grid's own id for the fixed lead identity track, which is not a data column. */
const LEADING_COLUMN_ID = "__leading__";
/**
 * What `GridTableV2` adds when a column resolves to an END alignment. Written
 * out rather than imported: importing the class the grid applies would police
 * nothing, because both arms would then agree by construction.
 */
const JUSTIFY_END_CLASS = "justify-end";
/**
 * A class that sits on a CHILD of the `changes` data cell, never on the cell
 * itself — so an assertion finding it proves the collector descends, which is
 * the only reason it can see an `ml-auto` a value primitive puts on its own
 * node. Written out for the same reason {@link JUSTIFY_END_CLASS} is.
 */
const DESCENDANT_VALUE_CLASS = "tabular-nums";
const BRANCH_DATA_COLUMN_IDS = [
  "owner",
  "priority",
  "collaborators",
  "sessions",
  "changes",
  "status",
  "pr",
  "lastActivity",
  "repo",
  "tags",
];
const STICKY_CLASS = "sticky";
const LEFT_EDGE_CLASS = "left-0";
const OPAQUE_SURFACE_CLASS = "bg-[var(--grid-table-surface,var(--background))]";

const ROW_A = BRANCH_ROW_A;
const ROW_B = BRANCH_ROW_B;

const BULK_ACTIONS = [
  {
    icon: null,
    id: "test-action",
    kind: "command" as const,
    label: "Archive",
    onSelect: () => undefined,
    undo: TableBulkActionUndo.NotImplemented,
  },
];

describe("BranchesListSurfaceV2", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps hidden columns in their canonical slots when reordering the visible subset", () => {
    const emitted: string[][] = [];

    const { container } = renderSurface({
      onColumnOrderChange: (order) => emitted.push(order),
      visibleColumns: new Set([
        "owner",
        "sessions",
        "changes",
        "status",
        "repo",
      ]),
    });

    const dataTransfer = createDataTransfer();
    fireEvent.dragStart(header(container, "sessions"), { dataTransfer });
    fireEvent.drop(header(container, "owner"), { dataTransfer });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain("collaborators");
    // Hidden `priority` (ISS-10332) and `collaborators` both keep their
    // canonical slots behind the moved `sessions`.
    expect(emitted[0].indexOf("priority")).toBe(1);
    expect(emitted[0].indexOf("collaborators")).toBe(2);
    expect(emitted[0].indexOf("sessions")).toBeLessThan(
      emitted[0].indexOf("owner")
    );
  });

  // ISS-9316 / PRD-716 phase 06. The adoption swaps WHERE the column facts are
  // derived and must not move a pixel, so this renders one set of inputs under
  // both arms and holds the registry arm to the hand-built one's RENDERED
  // result: the track string, the header order, and every header and body cell
  // subtree's classes.
  //
  // The THIRD render is what makes the alignment half real (tamsinb,
  // marisolashgrove — review of this PR). `resolveCellAlignEnd` returns `null`
  // whatever the column declares while `grid-table-v2-number-cell-align` is
  // closed, so with that key shut the one fact a registry column publishes and
  // a hand-built one does not is never exercised at all, and the two arms agree
  // for a reason that has nothing to do with this change. Opening it alongside
  // the registry key is what puts the published alignment on the wire.
  //
  // Opening it is NECESSARY AND NOT SUFFICIENT, which is the other half of the
  // same finding: the value primitives right-align themselves with `ml-auto` on
  // a child of the cell, not with `justify-end` on the cell, so a comparison
  // that read only the cell element would still see two identical arms while
  // they diverged inside. {@link cellClassNames} descends for that reason.
  it("renders the same tracks, order and cell classes from the column registry as by hand", () => {
    const inputs = {
      // `changes` is in the visible set on purpose: it is the one column whose
      // declared kind is a judgement call rather than an obvious mapping, so a
      // fixture that hid it could not see that kind decide an alignment.
      columnOrder: ["status", "owner", "changes", "sessions", "repo"],
      columnWidths: { owner: 240 },
      onColumnWidthChange: () => undefined,
      visibleColumns: new Set([
        "owner",
        "sessions",
        "changes",
        "status",
        "repo",
      ]),
    };

    const handBuilt = renderedLayout(inputs);
    const fromRegistry = renderedLayout({
      ...inputs,
      enabledFlags: [BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY],
    });
    const fromRegistryAligned = renderedLayout({
      ...inputs,
      enabledFlags: [
        BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY,
        GRID_TABLE_V2_NUMBER_CELL_ALIGN_FEATURE_FLAG_KEY,
      ],
    });

    // Anchored, so the two sides cannot agree by rendering nothing: the
    // persisted 240px override and the five chosen columns are both in it.
    expect(handBuilt.tracks).toContain("240px");
    expect(handBuilt.headers).toEqual([
      "status",
      "owner",
      "changes",
      "sessions",
      "repo",
      ROW_ACTIONS_COLUMN_ID,
    ]);
    // The positive control for the absence assertion on the next line, on the
    // SAME locator: the collector has to be matching real nodes AND descending
    // into them, or `not.toContain` below would be passing over an empty set.
    expect(handBuilt.classes.length).toBeGreaterThan(handBuilt.headers.length);
    expect(handBuilt.classes.join(" ")).toContain(DESCENDANT_VALUE_CLASS);
    expect(handBuilt.classes.join(" ")).not.toContain(JUSTIFY_END_CLASS);

    expect(fromRegistry.tracks).toBe(handBuilt.tracks);
    expect(fromRegistry.headers).toEqual(handBuilt.headers);
    expect(fromRegistry.classes).toEqual(handBuilt.classes);

    // With the alignment channel actually open, every Branches column resolving
    // `start` must still render exactly what it renders with the channel shut.
    // Put a value on `TableNumberCell` or `TableChangeCell` in a Branches column
    // and this is the assertion that goes red, because that primitive's own
    // default is end and the registry would now be overriding it.
    expect(fromRegistryAligned.tracks).toBe(handBuilt.tracks);
    expect(fromRegistryAligned.headers).toEqual(handBuilt.headers);
    expect(fromRegistryAligned.classes).toEqual(handBuilt.classes);
  });

  // The pair below is what makes that parity case mean something: without it,
  // it passes equally well when the gate never opens and BOTH arms render the
  // hand-built layout.
  //
  // It is the one place the arms genuinely differ, and it is differ-at-this-
  // seam only: `normalizeStoredTableView` already drops an unknown id on
  // restore, and `setColumnOrderSafe` filters the emitted order again on
  // write, so no production host can feed this component the id or persist it
  // back. Driving the component directly is what makes the seam observable.
  it("drops a persisted order id the registry never had", () => {
    const emitted: string[][] = [];

    const { container } = renderSurface({
      columnOrder: [RETIRED_COLUMN_ID, ...BRANCH_DATA_COLUMN_IDS],
      enabledFlags: [BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY],
      onColumnOrderChange: (order) => emitted.push(order),
    });
    dragColumnOnto(container, "sessions", "owner");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).not.toContain(RETIRED_COLUMN_ID);
    expect(emitted[0]).toContain("sessions");
  });

  it("carries that id back out again on the hand-built rollback path", () => {
    const emitted: string[][] = [];

    const { container } = renderSurface({
      columnOrder: [RETIRED_COLUMN_ID, ...BRANCH_DATA_COLUMN_IDS],
      onColumnOrderChange: (order) => emitted.push(order),
    });
    dragColumnOnto(container, "sessions", "owner");

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain(RETIRED_COLUMN_ID);
    expect(emitted[0]).toContain("sessions");
  });

  it("gates the enhanced adapter on the shared gridview adoption flag", () => {
    const closed = renderSurface({ rolloutFlags: [] });
    expect(gridHeader(closed.container)).not.toBeNull();
    expect(headerColumnIds(closed.container)).not.toContain(
      ROW_ACTIONS_COLUMN_ID
    );
    expect(
      closed.queryByRole("button", { name: "Branch actions" })
    ).not.toBeInTheDocument();
    closed.unmount();

    const assigned = renderSurface({
      rolloutFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });
    expect(gridHeader(assigned.container)).not.toBeNull();
    expect(headerColumnIds(assigned.container)).toContain(
      ROW_ACTIONS_COLUMN_ID
    );
    expect(
      assigned.getAllByRole("button", { name: "Branch actions" })
    ).toHaveLength(2);
  });

  it("reports the adapter actually rendered for flag-on and flag-off rows", () => {
    const closed = renderSurface({ rolloutFlags: [] });
    expect(headerColumnIds(closed.container)).not.toContain(
      ROW_ACTIONS_COLUMN_ID
    );
    expect(closed.capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.GridviewRolloutDecision,
      expect.objectContaining({
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Disabled,
        reason: BranchesListRolloutDecisionReason.RenderSettled,
        row_count: 2,
        surface: Surface.Web,
      })
    );
    closed.unmount();

    const assigned = renderSurface({
      rolloutFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });
    expect(headerColumnIds(assigned.container)).toContain(
      ROW_ACTIONS_COLUMN_ID
    );
    expect(assigned.capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.GridviewRolloutDecision,
      expect.objectContaining({
        component: SharedAnalyticsComponent.BranchesListSurfaceV2,
        outcome: GridviewRolloutDecisionOutcome.Enabled,
        reason: BranchesListRolloutDecisionReason.RenderSettled,
        row_count: 2,
        surface: Surface.Web,
      })
    );
  });

  it("keeps rollback when only a near-miss flag key is enabled", () => {
    const nearMiss = renderSurface({
      rolloutFlags: [`${GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY}-wrong`],
    });
    expect(headerColumnIds(nearMiss.container)).not.toContain(
      ROW_ACTIONS_COLUMN_ID
    );
    expect(nearMiss.capture).toHaveBeenCalledWith(
      SurfaceAnalyticsEvent.GridviewRolloutDecision,
      expect.objectContaining({
        outcome: GridviewRolloutDecisionOutcome.Disabled,
        reason: BranchesListRolloutDecisionReason.RenderSettled,
      })
    );
  });

  it("enables the enhanced adapter for disconnected readers", () => {
    const disconnectedStallCta = {
      signals: {
        hasAccount: true,
        isGitHubConnected: false,
      },
    };
    const assigned = renderSurface({
      rolloutFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      stallCta: disconnectedStallCta,
    });
    expect(gridHeader(assigned.container)).not.toBeNull();
    expect(headerColumnIds(assigned.container)).toContain(
      ROW_ACTIONS_COLUMN_ID
    );
  });

  it("enables the enhanced adapter without an integration-status signal", () => {
    const unresolved = renderSurface({
      rolloutFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      stallCta: {
        signals: {
          hasAccount: true,
          isGitHubConnected: true,
        },
      },
    });

    expect(gridHeader(unresolved.container)).not.toBeNull();
    expect(headerColumnIds(unresolved.container)).toContain(
      ROW_ACTIONS_COLUMN_ID
    );
  });

  it("keeps the adapter active while reporting partial hydration and parity", () => {
    const hydration = renderSurface({
      items: [{ ...ROW_A, dataState: BranchDataState.AwaitingSync }, ROW_B],
    });
    expect(gridHeader(hydration.container)).not.toBeNull();
    hydration.unmount();

    const parity = renderSurface({
      hasCompletePopulation: true,
      total: 3,
    });
    expect(gridHeader(parity.container)).not.toBeNull();
  });

  it("applies persisted column widths to the v2 grid tracks", () => {
    renderSurface({
      columnWidths: { owner: 240 },
      onColumnWidthChange: () => undefined,
    });

    const ownerHeader = screen.getByRole("columnheader", {
      name: RE_OWNER_HEADER,
    });
    const headerRow = ownerHeader.closest("div.grid");

    expect(headerRow).not.toBeNull();
    expect(headerRow?.getAttribute("style")).toContain("240px");
  });

  it("pins the Name column through the shared pinned-column flag", () => {
    renderSurface({
      enabledFlags: [BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY],
    });

    expect(
      screen.getByRole("columnheader", { name: RE_NAME_HEADER })
    ).toHaveClass(STICKY_CLASS, LEFT_EDGE_CLASS, OPAQUE_SURFACE_CLASS);
    expect(leadBodyCell()).toHaveClass(
      STICKY_CLASS,
      LEFT_EDGE_CLASS,
      OPAQUE_SURFACE_CLASS
    );
  });

  it("leaves the Name column unpinned when the shared pinned-column flag is off", () => {
    renderSurface();

    expect(
      screen.getByRole("columnheader", { name: RE_NAME_HEADER })
    ).not.toHaveClass(STICKY_CLASS, LEFT_EDGE_CLASS);
    expect(leadBodyCell()).not.toHaveClass(STICKY_CLASS, LEFT_EDGE_CLASS);
  });

  it("keeps the mainline wide layout at a narrow viewport while rollout is off", () => {
    stubNarrowViewport();

    renderSurface({ rolloutFlags: [] });

    expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(1);
    expect(
      screen.getByRole("columnheader", { name: RE_OWNER_HEADER })
    ).toBeVisible();
  });

  it("shows the canonical status icon and truncated title in the narrow production row", () => {
    stubNarrowViewport();

    renderSurface({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });

    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    const statusLabel = artifactStatusFullLabel(
      artifactStatusView(
        ROW_A.artifactId ?? ROW_A.id,
        ArtifactStatusVocabulary.Branch,
        branchStatusEvidence(ROW_A)
      )
    );
    expect(screen.getAllByLabelText(statusLabel)).toHaveLength(2);
    expect(screen.getByText(ROW_A.branchName)).toHaveClass("truncate");
  });

  it("keeps Ctrl+A row selection without a narrow header checkbox", () => {
    stubNarrowViewport();

    renderSurface({
      bulkActions: BULK_ACTIONS,
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });

    expect(screen.queryByRole("checkbox", { name: "Select all" })).toBeNull();
    const renderedCell = document.querySelector<HTMLElement>(
      `[data-grid-row-id="${ROW_A.id}"] [data-grid-cell]`
    );
    if (!renderedCell) {
      throw new Error("rendered Branch cell not found");
    }
    fireEvent.keyDown(renderedCell, { ctrlKey: true, key: "a" });

    const selectedRows = document.querySelectorAll(
      '[data-grid-row][aria-selected="true"]'
    );
    expect(selectedRows).toHaveLength(2);
  });

  it("states the range from the page index its own pager is counting from", () => {
    renderSurface({ page: 1, pageSize: 25, total: 27, totalPages: 2 });

    // 26-27, not 1-2: the rows on screen are page ONE's in index terms, and a
    // readout built from any other index would name a page the buttons are not
    // on. No host supplies this sentence any more.
    expect(screen.getByRole("status")).toHaveTextContent("26–27 of 27");
  });

  it("states no range while a placeholder page stands in for the one the index names", () => {
    renderSurface({
      isPlaceholderData: true,
      page: 1,
      pageSize: 25,
      total: 27,
      totalPages: 2,
    });

    // ISS-9216: the suppression Sessions shipped and this list did not. Both
    // hosts stated `from-to of total` unconditionally, so this window asserted
    // the NEW page's range over rows `keepPreviousData` was still holding.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // BEHAVIOR CHANGE (ISS-10245): this case used to assert BOTH arms, because a
  // closed-by-default flag's one failure mode is a `navigableHeaderCells` that
  // is never gated at all. `grid-table-v2-navigable-header-cells` was retired
  // ENABLED by operator ruling, so the closed arm asserts a state the surface
  // can no longer reach and is gone; what survives is that this surface still
  // wires the roving contract, which is the half that can still break. The
  // header cells are read through `columnheader` rather than by counting
  // `[data-grid-cell]` document-wide, because body rows carry that attribute.
  it("joins the shared header roving contract unconditionally", () => {
    const { container } = renderSurface();

    expect(
      container.querySelector('[data-grid-row-id="__grid-chrome__header"]')
    ).not.toBeNull();
    expect(columnHeaders().length).toBeGreaterThan(0);
    expect(
      columnHeaders().every((header) => header.hasAttribute("data-grid-cell"))
    ).toBe(true);
    expect(
      screen.getByRole("columnheader", { name: RE_OWNER_HEADER })
    ).toHaveAttribute("aria-sort");
  });

  it("keeps the rows-per-page footer mounted and disabled while placeholder data is withheld", () => {
    renderSurface({
      items: [],
      isPlaceholderData: true,
      pageSize: 50,
      total: 0,
      totalPages: 0,
    });

    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps the footer mounted for a positive-total page with no visible rows", () => {
    renderSurface({
      items: [],
      page: 2,
      total: 27,
      totalPages: 3,
    });

    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).not.toBeInTheDocument();
  });

  // ISS-9429: before this the render helper hardcoded `isError={false}` and did
  // not even accept it, so the v2 surface's error branch was exercised by
  // nothing — which is how the branch survived being unreachable whenever rows
  // were still held. Driving `isError` WITH a facet narrowing the page to zero
  // is the exact permutation the old `isError && !hasRows` gate skipped.
  it("names a failed read rather than a filtered empty when the page is narrowed to zero", () => {
    renderSurface({
      hasActiveFilters: true,
      isError: true,
      items: [],
      total: 0,
      totalPages: 0,
    });

    expect(screen.getByText("Couldn't load branches")).toBeInTheDocument();
    expect(screen.getByRole("alert").parentElement).toHaveClass("px-4");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No matching branches")).not.toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).not.toBeInTheDocument();
  });

  it("keeps retained rows visible while the surface state reports a read error", () => {
    const { container } = renderSurface({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      hasCompletePopulation: true,
      isError: true,
      items: [ROW_A],
      total: 1,
      totalPages: 1,
    });

    expect(screen.getByText(ROW_A.branchName)).toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load branches")
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(contractWrapper(container)).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Error
    );
    expect(contractWrapper(container)).not.toHaveAttribute("aria-invalid");
  });

  it("marks retained placeholder rows as loading without inventing a settled state", () => {
    const { container } = renderSurface({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
      isPlaceholderData: true,
    });

    expect(contractWrapper(container)).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Loading
    );
    expect(contractWrapper(container)).toHaveAttribute("aria-busy", "true");
  });

  it("leaves the mastered state absent for settled rows", () => {
    const { container } = renderSurface({
      enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
    });

    expect(contractWrapper(container)).not.toHaveAttribute(
      "data-interaction-state"
    );
    expect(contractWrapper(container)).not.toHaveAttribute("aria-busy");
    expect(contractWrapper(container)).not.toHaveAttribute("aria-invalid");
  });

  it("names a facet-narrowed empty without claiming the org has no branches", () => {
    renderSurface({
      hasActiveFilters: true,
      items: [],
      total: 0,
      totalPages: 0,
    });

    expect(screen.getByText("No matching branches")).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Couldn't load branches")
    ).not.toBeInTheDocument();
  });
});

function renderSurface({
  bulkActions,
  columnOrder,
  columnWidths,
  enabledFlags = [],
  hasActiveFilters = false,
  hasCompletePopulation = false,
  isError = false,
  isPlaceholderData = false,
  items = [ROW_A, ROW_B],
  onColumnOrderChange,
  onColumnWidthChange,
  page = 0,
  pageSize = 25,
  rolloutFlags = [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
  stallCta = {
    signals: {
      hasAccount: true,
      isGitHubConnected: true,
    },
  },
  total = 2,
  totalPages = 1,
  visibleColumns = new Set([
    "owner",
    "collaborators",
    "sessions",
    "changes",
    "status",
    "pr",
    "lastActivity",
    "repo",
    "tags",
  ]),
}: {
  bulkActions?: ComponentProps<typeof BranchesListSurfaceV2>["bulkActions"];
  columnOrder?: readonly string[];
  columnWidths?: Readonly<Record<string, number>>;
  enabledFlags?: string[];
  hasActiveFilters?: boolean;
  hasCompletePopulation?: boolean;
  isError?: boolean;
  isPlaceholderData?: boolean;
  items?: BranchRow[];
  onColumnOrderChange?: (nextOrder: string[]) => void;
  onColumnWidthChange?: (columnId: string, widthPx: number) => void;
  page?: number;
  pageSize?: number;
  rolloutFlags?: string[];
  stallCta?: {
    signals: {
      hasAccount: boolean;
      isGitHubConnected: boolean;
    };
  };
  total?: number;
  totalPages?: number;
  visibleColumns?: Set<string>;
} = {}) {
  const capture = vi.fn();
  const result = render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [...rolloutFlags, ...(enabledFlags ?? [])],
      })}
    >
      <SurfaceAnalyticsProvider capture={capture} surface={Surface.Web}>
        <BranchesListSurfaceV2
          allRows={items}
          bulkActions={bulkActions}
          columnOrder={columnOrder}
          columnWidths={columnWidths}
          hasActiveFilters={hasActiveFilters}
          hasCompletePopulation={hasCompletePopulation}
          hasWindow={false}
          isError={isError}
          isPending={false}
          isPlaceholderData={isPlaceholderData}
          items={items}
          onColumnOrderChange={onColumnOrderChange}
          onColumnWidthChange={onColumnWidthChange}
          onPageChange={() => undefined}
          onPageSizeChange={() => undefined}
          onRetry={() => undefined}
          onShowAllTime={() => undefined}
          onSort={() => undefined}
          page={page}
          pageSize={pageSize}
          sortBy="lastActivity"
          sortDir="desc"
          stallCta={stallCta}
          {...branchesListSurfaceV2SummaryPropsFixture()}
          toolbar={branchesToolbarPropsFixture({ rows: items, visibleColumns })}
          total={total}
          totalPages={totalPages}
          visibleColumns={visibleColumns}
        />
      </SurfaceAnalyticsProvider>
    </FeatureFlagAdapterProvider>
  );
  return { ...result, capture };
}

function gridHeader(container: HTMLElement): Element | null {
  return container.querySelector('[data-grid-row-id="__grid-chrome__header"]');
}

/** The `gridTemplateColumns` the header row is actually painting. */
function gridTracks(container: HTMLElement): string {
  const headerRow = header(container, "owner").closest("div.grid");
  const tracks = headerRow?.getAttribute("style");
  if (!tracks) {
    throw new Error("the header row is painting no grid tracks");
  }
  return tracks;
}

/**
 * Every rendered cell SUBTREE's classes — headers and body cells alike, each
 * cell followed by its descendants — in render order.
 *
 * Descending is load-bearing, not thoroughness (tamsinb, review of this PR).
 * A column that resolves to END puts `justify-end` on the cell, but the value
 * primitives inside right-align themselves with `ml-auto` on a child span,
 * which is the channel `resolveCellAlignEnd` actually steers. Reading only the
 * cell element leaves the two arms comparing equal while the values inside them
 * sit at opposite edges.
 */
function cellClassNames(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[role="columnheader"], [role="cell"], [role="gridcell"]'
    )
  ).flatMap((cell) =>
    // `getAttribute`, not `className`: an inline `<svg>` icon's `className` is
    // an `SVGAnimatedString`, which would compare by identity and make every
    // arm differ.
    [cell, ...Array.from(cell.querySelectorAll<Element>("*"))].map(
      (element) => element.getAttribute("class") ?? ""
    )
  );
}

/** One render's observable layout, so a case can compare whole arms. */
function renderedLayout(options: Parameters<typeof renderSurface>[0]): {
  classes: string[];
  headers: string[];
  tracks: string;
} {
  const { container, unmount } = renderSurface(options);
  const layout = {
    classes: cellClassNames(container),
    headers: headerColumnIds(container),
    tracks: gridTracks(container),
  };
  unmount();
  return layout;
}

/** The rendered data columns, in render order. */
function headerColumnIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[role="columnheader"][data-column-id]'
    )
  )
    .map((element) => element.dataset.columnId ?? "")
    .filter((columnId) => columnId !== LEADING_COLUMN_ID);
}

function dragColumnOnto(
  container: HTMLElement,
  columnId: string,
  ontoColumnId: string
): void {
  const dataTransfer = createDataTransfer();
  fireEvent.dragStart(header(container, columnId), { dataTransfer });
  fireEvent.drop(header(container, ontoColumnId), { dataTransfer });
}

function header(container: HTMLElement, columnId: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    `[role="columnheader"][data-column-id="${columnId}"]`
  );
  if (!element) {
    throw new Error(`no rendered header for "${columnId}"`);
  }
  return element;
}

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

function columnHeaders(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[role='columnheader']")
  );
}

function leadBodyCell(): HTMLElement {
  const cell = screen
    .getByText(ROW_A.branchName)
    .closest('[role="cell"], [role="gridcell"]');
  if (!(cell instanceof HTMLElement)) {
    throw new Error("branch name is not inside a table cell");
  }
  return cell;
}

function stubNarrowViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string): MediaQueryList => ({
        addEventListener: () => undefined,
        addListener: () => undefined,
        dispatchEvent: () => true,
        matches: true,
        media: query,
        onchange: null,
        removeEventListener: () => undefined,
        removeListener: () => undefined,
      })
    )
  );
}

function contractWrapper(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>(
    '[data-grid-interaction-contract="pointer-hover"]'
  );
  if (!wrapper) {
    throw new Error("pointer interaction contract is not rendered");
  }
  return wrapper;
}
