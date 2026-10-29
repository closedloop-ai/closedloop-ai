// Composites copy of stories/grid-table-list-surface.stories.tsx (Primitives
// v1.0/Data Display/Tables/Grid Table List Surface), so the current Storybook
// can change without touching v1.0. Sessions, Branches and Documents lists all
// render it, so it sits under Shared/Artifact List (TAXONOMY.md, "The page
// tree"). Selection Rail and Compact Selection Rail are new here (ISS-12305).

/**
 * The band layout every v2 list surface shares — ISS-9296.
 *
 * It exists because that band structure was the part that got copy-pasted — the
 * Generic Artifact prototype, the Sessions listing and the Branches listing each
 * had their own, which is how they drifted apart.
 *
 * WHAT THIS COMPONENT ACTUALLY OWNS: the bands, scroll container, and one
 * measured responsive mode passed to opt-in toolbar and table slots. It does
 * not own loading, empty or error. Static `table` nodes remain opaque, so the
 * host decides what a load or a failure looks like. PRD-713 assigns those states to "the shared
 * surface"; the shipped component has no such branch, and that gap is reported
 * on the ticket rather than papered over here.
 *
 * So the three state stories below assert only the surface's own contribution in
 * each state — which bands it composes around the host's node, and that the
 * toolbar stays outside the scroller and operable. An earlier draft asserted the
 * state nodes themselves, which was vacuous: the story rendered those branches
 * in its own harness and then asserted its own harness had rendered them.
 *
 * Applicable states: default, partial (metrics absent), narrow (the metric
 * strip's snapping carousel), and the three host-supplied states as band
 * compositions. Overflow is visual only here — the scroll band's ownership is
 * asserted structurally in `Default`, but the scrolling itself is not, because
 * jsdom lays nothing out. Not applicable: hover,
 * focus-visible, selected, editing, dragging, drag-over, disabled, read-only and
 * permission — this component owns no control and no row.
 */

import { selectionSentence } from "@repo/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { GridInteractionArtifactListSurface } from "@repo/app/shared/components/generic-artifact-surface/preview/components/grid-interaction-artifact-list-surface";
import { genericArtifacts } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "@repo/app/tags/lib/bulk-tag-labels";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { GridInteractionContract } from "@repo/design-system/components/ui/grid-interaction-contract";
import { GridRowDragHandle } from "@repo/design-system/components/ui/grid-row-drag-handle";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-card";
import {
  GRID_TABLE_METRIC_BAND_TEST_ID,
  GRID_TABLE_METRIC_CARD_CLASS,
  GRID_TABLE_PAGINATION_BAND_TEST_ID,
  GRID_TABLE_SCROLL_BAND_TEST_ID,
  GridTableListSurface,
  GridTableMetricStrip,
} from "@repo/design-system/components/ui/grid-table-list-surface";
import { GridTableToolbar } from "@repo/design-system/components/ui/grid-table-toolbar";
import {
  GridTableV2,
  type GridTableV2Column,
  type GridTableV2Group,
} from "@repo/design-system/components/ui/grid-table-v2";
import { GridTableV2Card } from "@repo/design-system/components/ui/grid-table-v2-card";
import { Input } from "@repo/design-system/components/ui/input";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  TableBulkActionBar,
  TableBulkActionButton,
} from "@repo/design-system/components/ui/table-bulk-action-bar";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import { GridInteractionState } from "@repo/design-system/lib/grid-interaction-contract";
import { GridTableV2Mode } from "@repo/design-system/lib/grid-table-v2-types";
import type { Meta, StoryObj } from "@storybook/react";
import { AlertCircleIcon, InboxIcon, TagIcon, TagsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { expect, fireEvent, userEvent, within } from "storybook/test";

const meta = {
  title: "Composites/Shared/Artifact List/Grid Table List Surface",
  component: GridTableListSurface,
  tags: ["stable", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableListSurface>;

// No controls: each story fixes a complete band and row fixture, while callbacks and slots are parent-driven.

export default meta;

type Story = StoryObj<typeof meta>;

const TOOLBAR_LABEL = "Filter artifacts";
const METRIC_LABELS = ["Artifacts", "Token spend", "Creation cost"];
const ROW_LABELS = ["Alpha", "Bravo", "Charlie"];
const SELECTED_COUNT = 2;

/**
 * All four bands. The assertion that matters is the scroll ownership: the TABLE
 * band is the surface's only scroll container, and the toolbar, metric and
 * pagination bands sit OUTSIDE it so they stay put while the columns move.
 *
 * A surface that nested the toolbar inside the scroller would look identical at
 * rest and slide its own filters off-screen on the first horizontal scroll.
 */
export const Default: Story = {
  args: { table: null, toolbar: null },
  render: () => <ListSurfaceStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const scrollBand = canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);

    // The rows are inside the scroller...
    for (const label of ROW_LABELS) {
      await expect(scrollBand).toHaveTextContent(label);
    }

    // ...and the three bands that must not move are outside it.
    await expect(
      scrollBand.contains(
        canvas.getByRole("searchbox", { name: TOOLBAR_LABEL })
      )
    ).toBe(false);
    await expect(
      scrollBand.contains(canvas.getByTestId(GRID_TABLE_METRIC_BAND_TEST_ID))
    ).toBe(false);
    await expect(
      scrollBand.contains(
        canvas.getByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID)
      )
    ).toBe(false);
  },
};

/**
 * A read in flight, composed into the shell by the host.
 *
 * The surface's own contribution here is that it keeps the TOOLBAR band — a
 * surface that swapped its whole frame for a spinner would throw away the
 * filters the user just typed and make every refetch feel like a navigation.
 * The skeleton itself is the host's; the story asserts where the shell puts it,
 * not that the host rendered it.
 */
export const Loading: Story = {
  args: { table: null, toolbar: null },
  render: () => <ListSurfaceStory state="loading" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const scrollBand = canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);

    // The host's node goes in the SCROLL band, not loose in the frame.
    await expect(
      scrollBand.contains(canvas.getByLabelText(LOADING_LABEL))
    ).toBe(true);

    // The toolbar survives the load, and survives it OUTSIDE the scroller.
    const search = canvas.getByRole("searchbox", { name: TOOLBAR_LABEL });
    await expect(search).toBeEnabled();
    await expect(scrollBand.contains(search)).toBe(false);
  },
};

/**
 * A read that completed and found nothing.
 *
 * The surface's contribution is dropping the pagination BAND: a page control
 * over zero rows invites the reader to look for rows on page two. Asserted on
 * the band's own anchor rather than on the `navigation` role inside it, because
 * the control is the host's — querying the role cannot tell "no band" apart from
 * "an empty bordered band", and the second is the FEA-4217 defect.
 */
export const Empty: Story = {
  args: { table: null, toolbar: null },
  render: () => <ListSurfaceStory state="empty" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.queryByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID)
    ).toBeNull();

    // The host's empty node still lands in the scroll band, so an empty list
    // occupies the same region a full one does rather than collapsing the frame.
    await expect(
      canvas
        .getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID)
        .contains(canvas.getByText(EMPTY_TITLE))
    ).toBe(true);
  },
};

/**
 * A read that failed. Same band composition as `Empty` — no pagination over a
 * result set that does not exist — but the host's node says so rather than
 * claiming there is nothing here, which is a question that was never answered.
 */
export const LoadFailed: Story = {
  args: { table: null, toolbar: null },
  render: () => <ListSurfaceStory state="error" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const scrollBand = canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID);

    await expect(
      canvas.queryByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID)
    ).toBeNull();
    await expect(scrollBand.contains(canvas.getByRole("alert"))).toBe(true);

    // The toolbar is still outside the scroller, so the user can change the
    // query instead of only retrying the failed one.
    await expect(
      scrollBand.contains(
        canvas.getByRole("searchbox", { name: TOOLBAR_LABEL })
      )
    ).toBe(false);

    // The retry is a real transition, not an enabled control with no action:
    // clicking it succeeds the read, and the surface RECOMPOSES around the
    // host's new node — the alert goes and the pagination band the failure
    // suppressed comes back. A button wired to nothing leaves both unchanged.
    await userEvent.click(canvas.getByRole("button", { name: RETRY_LABEL }));
    await expect(
      await canvas.findByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID)
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("alert")).toBeNull();
  },
};

/**
 * A surface whose metrics are all hidden drops the BAND, rather than keeping
 * its padding around a strip rendering nothing (FEA-4217) — otherwise the
 * unexplained empty space the reader asked to remove just moves up one level.
 *
 * The negative sibling of `Default`'s metric-band assertion: same locator,
 * opposite expectation. A surface that always rendered the band would pass
 * `Default` and fail only here.
 */
export const WithoutMetrics: Story = {
  args: { table: null, toolbar: null },
  render: () => <ListSurfaceStory metrics={null} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.queryByTestId(GRID_TABLE_METRIC_BAND_TEST_ID)
    ).toBeNull();

    // The other three bands are untouched, so dropping metrics is not a way to
    // lose the toolbar as well.
    await expect(
      canvas.getByRole("searchbox", { name: TOOLBAR_LABEL })
    ).toBeInTheDocument();
    await expect(
      canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID)
    ).toBeInTheDocument();
  },
};

/**
 * A grouped surface renders NO pagination band: a page boundary cutting through
 * a group paints a section header with rows missing beneath it, which reads as
 * data loss rather than as pagination.
 *
 * The negative sibling of `Default`'s pagination-band assertion — same anchor,
 * opposite expectation.
 */
export const GroupedWithoutPagination: Story = {
  args: { table: null, toolbar: null },
  render: () => <ListSurfaceStory pagination={null} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      canvas.queryByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID)
    ).toBeNull();
    await expect(
      canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID)
    ).toHaveTextContent(ROW_LABELS[0]);
  },
};

/** One measured compact answer drives both toolbar and canonical narrow rows. */
export const MeasuredCompact: Story = {
  args: { table: null, toolbar: null },
  render: () => (
    <MeasuredListSurfaceStory
      initialMode="compact"
      initialWidth={CARD_FALLBACK_BREAKPOINT - 1}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("grid-table-measured-width-host");
    await expect(host).toHaveAttribute(
      "style",
      `width: ${CARD_FALLBACK_BREAKPOINT - 1}px;`
    );
    if (!hasBrowserLayout(host)) {
      return;
    }
    await expect(canvas.getByRole("button", { name: "View" })).toBeVisible();
    const grid = canvas.getByRole("grid");
    await expect(grid).toBeVisible();
    await expect(grid).toHaveClass("min-w-0");
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    await expect(canvas.getByRole("columnheader")).toHaveTextContent("Name");
    await expect(canvas.queryByText("Ada Lovelace")).toBeNull();
  },
};

/** At the exact boundary the expanded toolbar and full grid mount together. */
export const MeasuredExpanded: Story = {
  args: { table: null, toolbar: null },
  render: () => (
    <MeasuredListSurfaceStory
      initialMode="expanded"
      initialWidth={CARD_FALLBACK_BREAKPOINT}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("grid-table-measured-width-host");
    await expect(host).toHaveStyle({ width: `${CARD_FALLBACK_BREAKPOINT}px` });
    if (!hasBrowserLayout(host)) {
      return;
    }
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
    await expect(canvas.getByRole("grid")).toHaveClass("min-w-fit");
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(2);
    await expect(canvas.getByText("Ada Lovelace")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "View" })).toBeNull();
  },
};

/** A focused narrow-row action keeps focus after expanding the same grid. */
export const MeasuredFocusHandoff: Story = {
  args: { table: null, toolbar: null },
  render: () => (
    <MeasuredListSurfaceStory
      initialMode="compact"
      initialWidth={CARD_FALLBACK_BREAKPOINT - 1}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("grid-table-measured-width-host");
    await expect(host).toHaveStyle({
      width: `${CARD_FALLBACK_BREAKPOINT - 1}px`,
    });
    if (!hasBrowserLayout(host)) {
      return;
    }
    const trigger = canvas.getByRole("button", { name: "Alpha" });
    await userEvent.click(trigger);
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(2);
    await expect(canvas.getByRole("grid")).toHaveClass("min-w-fit");
    await expect(trigger).toHaveFocus();
  },
};

export const SelectionRail: Story = {
  args: { table: null, toolbar: null },
  render: () => <SelectionRailStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rail = canvas.getByRole("toolbar", {
      name: selectionSentence(SELECTED_COUNT),
    });
    await expect(
      canvas.getByTestId(GRID_TABLE_SCROLL_BAND_TEST_ID).contains(rail)
    ).toBe(false);
    await expect(
      within(rail).getByRole("button", { name: BULK_REMOVE_TAG_ACTION_LABEL })
    ).toBeEnabled();
    await userEvent.click(
      within(rail).getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    await expect(
      within(rail).getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeDisabled();
  },
};

/**
 * A selected narrow list on a phone: the rail floats above the list rather than
 * taking a band from it (operator ruling, ISS-12305 iPhone retest), and the
 * next-page control stays reachable.
 */
export const CompactSelectionRail: Story = {
  args: { table: null, toolbar: null },
  globals: { viewport: { value: "mobile1" } },
  render: () => (
    <div className="w-full max-w-sm">
      <SelectionRailStory table={<NarrowSelectionTable />} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const next = canvas.getByLabelText("Go to next page");
    const addTag = canvas.getByRole("button", { name: BULK_TAG_ACTION_LABEL });
    const removeTag = canvas.getByRole("button", {
      name: BULK_REMOVE_TAG_ACTION_LABEL,
    });
    await userEvent.click(next);
    await expect(
      within(canvas.getByTestId(GRID_TABLE_PAGINATION_BAND_TEST_ID)).getByText(
        "2",
        { exact: true }
      )
    ).toHaveAttribute("aria-current", "page");
    await expect(addTag).toBeEnabled();
    const grid = canvas.getByRole("grid");
    await expect(grid).toHaveClass("min-w-0");
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    await expect(removeTag).toBeEnabled();
  },
};

const LOADING_LABEL = "Loading artifacts";
const EMPTY_TITLE = "No artifacts yet";
const ERROR_TITLE = "Could not load artifacts";
const RETRY_LABEL = "Try again";

type SurfaceState = "loaded" | "loading" | "empty" | "error";

function ListSurfaceStory({
  bulkActions,
  metrics = <StoryMetrics />,
  pagination = <StoryPagination />,
  state = "loaded",
  table,
}: {
  bulkActions?: ReactNode;
  metrics?: ReactNode;
  pagination?: ReactNode;
  state?: SurfaceState;
  table?: ReactNode;
}) {
  // Held as state so the error node's retry is a REAL transition. A control the
  // host renders enabled but wires to nothing is a UI lying about what it can
  // do, and a story asserting only that it is enabled asserts nothing.
  const [surfaceState, setSurfaceState] = useState<SurfaceState>(state);
  const isLoaded = surfaceState === "loaded";

  return (
    <main className="flex h-screen flex-col bg-background">
      <GridTableListSurface
        bulkActions={bulkActions}
        className="flex-1 rounded-md border"
        metrics={metrics}
        pagination={isLoaded ? pagination : null}
        table={
          table ?? (
            <StoryTable
              onRetry={() => setSurfaceState("loaded")}
              state={surfaceState}
            />
          )
        }
        toolbar={<StoryToolbar />}
      />
    </main>
  );
}

function SelectionRailStory({ table }: { table?: ReactNode }) {
  const [pending, setPending] = useState(false);
  return (
    <ListSurfaceStory
      bulkActions={
        <TableBulkActionBar
          actionLabel={selectionSentence(SELECTED_COUNT)}
          actions={
            <>
              <TableBulkActionButton
                disabled={pending}
                label={BULK_TAG_ACTION_LABEL}
                onClick={() => setPending(true)}
              >
                <TagIcon />
              </TableBulkActionButton>
              <TableBulkActionButton
                disabled={pending}
                label={BULK_REMOVE_TAG_ACTION_LABEL}
                onClick={() => setPending(true)}
              >
                <TagsIcon />
              </TableBulkActionButton>
            </>
          }
        />
      }
      table={table}
    />
  );
}

function NarrowSelectionTable() {
  return (
    <GridTableV2
      columns={[{ id: "owner", label: "Owner" }]}
      getRowId={(row) => row.id}
      gridTemplateColumns="minmax(12rem,1fr) minmax(8rem,1fr)"
      isRowSelected={() => true}
      items={MEASURED_ROWS}
      leadingLabel="Artifact"
      mode="compact"
      renderCell={(_columnId, row) => row.owner}
      renderLead={(row) => row.name}
    />
  );
}

function StoryToolbar() {
  const [query, setQuery] = useState("");

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={TOOLBAR_LABEL}
        className="max-w-xs"
        onChange={(event) => setQuery(event.target.value)}
        type="search"
        value={query}
      />
    </div>
  );
}

/**
 * `value={null}` is the metric's own no-data rendering (FEA-4236), not a
 * placeholder this story draws: the strip's job here is layout, and inventing a
 * number would make the frame story assert a figure nothing computed.
 */
function StoryMetrics() {
  return (
    <GridTableMetricStrip>
      {METRIC_LABELS.map((label) => (
        <MetricCard
          className={GRID_TABLE_METRIC_CARD_CLASS}
          key={label}
          label={label}
          value={null}
        />
      ))}
    </GridTableMetricStrip>
  );
}

function StoryPagination() {
  const [page, setPage] = useState(0);

  return <TablePagination onPageChange={setPage} page={page} totalPages={4} />;
}

function StoryTable({
  onRetry,
  state,
}: {
  onRetry: () => void;
  state: SurfaceState;
}) {
  if (state === "loading") {
    return (
      <output aria-label={LOADING_LABEL} className="flex flex-col gap-2 p-3">
        {ROW_LABELS.map((label) => (
          <Skeleton className="h-9 w-full" key={label} />
        ))}
      </output>
    );
  }

  if (state === "empty") {
    return (
      <EmptyState
        description="Artifacts created in this project will appear here."
        icon={InboxIcon}
        title={EMPTY_TITLE}
      />
    );
  }

  if (state === "error") {
    return (
      <div className="p-4">
        <Alert variant="error">
          <AlertCircleIcon />
          <AlertTitle>{ERROR_TITLE}</AlertTitle>
          <AlertDescription>
            <p>
              The request did not complete, so this list is not showing your
              artifacts.
            </p>
            <Button onClick={onRetry} size="sm" variant="outline">
              {RETRY_LABEL}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // An identity track plus one per metric label. Wide enough to read as a grid;
  // no story asserts the horizontal scroll itself, because jsdom lays nothing
  // out and a `scrollWidth > clientWidth` check would pass on zeroes.
  return (
    <div className="min-w-fit">
      {ROW_LABELS.map((label) => (
        <div className="flex border-b last:border-b-0" key={label}>
          <div className="flex h-9 w-64 shrink-0 items-center px-3 text-sm">
            {label}
          </div>
          {METRIC_LABELS.map((column) => (
            <div
              className="flex h-9 w-48 shrink-0 items-center border-l px-3 text-sm"
              key={column}
            >
              <GridEmptyValue />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function MeasuredListSurfaceStory({
  initialMode,
  initialWidth,
}: {
  initialMode: "compact" | "expanded";
  initialWidth: number;
}) {
  const [mode, setMode] = useState(initialMode);

  return (
    <div
      className="max-w-full"
      data-testid="grid-table-measured-width-host"
      style={{ width: initialWidth }}
    >
      <GridTableListSurface
        mode={mode}
        table={(mode) => (
          <GridTableV2
            columns={[{ id: "owner", label: "Owner" }]}
            getRowId={(row) => row.id}
            gridTemplateColumns="minmax(12rem,1fr) minmax(8rem,1fr)"
            items={MEASURED_ROWS}
            leadingLabel="Name"
            mode={mode}
            renderCell={(_columnId, row) => row.owner}
            renderLead={(row) => (
              <Button
                className="justify-start self-start"
                onClick={() =>
                  setMode((current) =>
                    current === "compact" ? "expanded" : "compact"
                  )
                }
                type="button"
                variant="ghost"
              >
                {row.name}
              </Button>
            )}
          />
        )}
        tableScrollAttributes={{
          "aria-label": "Rows",
          role: "region",
          tabIndex: 0,
        }}
        toolbar={(mode) => (
          <GridTableToolbar
            compact={<Button variant="outline">View</Button>}
            expanded={<Button variant="outline">Options</Button>}
            mode={mode}
          />
        )}
      />
    </div>
  );
}

const MEASURED_ROWS = [{ id: "alpha", name: "Alpha", owner: "Ada Lovelace" }];

function hasBrowserLayout(host: HTMLElement): boolean {
  return host.getBoundingClientRect().width > 0;
}

export const ComposedGrid: Story = {
  args: { table: null, toolbar: null },
  tags: ["!stable", "preview"],
  render: () => <PointerContractGridStory />,
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector<HTMLElement>(
      '[data-grid-row-id="pointer-alpha"]'
    );
    const handle = row?.querySelector<HTMLElement>(
      "[data-grid-row-drag-handle]"
    );
    const band = Array.from(
      canvasElement.querySelectorAll<HTMLElement>('[role="rowgroup"]')
    ).find((candidate) => candidate.textContent?.includes("Done"));
    if (!(row && handle && band)) {
      throw new Error("composed grid did not render its drag path");
    }
    const dataTransfer = createPointerContractDataTransfer();
    fireEvent.pointerDown(handle, pointerContractEvent(1, 0, 0));
    fireEvent.pointerMove(handle, pointerContractEvent(1, 6, 0));
    fireEvent.dragStart(row, { dataTransfer });
    await expect(row).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.Dragging
    );
    fireEvent.dragOver(band, { dataTransfer });
    await expect(band).toHaveAttribute(
      "data-interaction-state",
      GridInteractionState.DragOver
    );
    fireEvent.drop(band, { dataTransfer });
    await expect(band).not.toHaveAttribute("data-interaction-state");
    await expect(
      canvasElement.querySelector('[data-testid="pointer-contract-moves"]')
    ).toHaveTextContent("1");
    fireEvent.dragEnd(row, { dataTransfer });
    await expect(row).not.toHaveAttribute("data-interaction-state");
  },
};

export const CanonicalArtifactListContract: Story = {
  args: { table: null, toolbar: null },
  tags: ["!stable", "preview"],
  render: () => <CanonicalArtifactListContractStory />,
  play: async ({ canvasElement }) => {
    const contract = canvasElement.querySelector(
      '[data-grid-interaction-contract="pointer-hover"]'
    );
    await expect(contract).not.toBeNull();
    await expect(contract?.querySelector("[data-grid-row]")).not.toBeNull();
  },
};

function CanonicalArtifactListContractStory() {
  const [openedArtifactId, setOpenedArtifactId] = useState<string | null>(null);
  return (
    <main>
      <output className="sr-only" data-testid="opened-artifact-id">
        {openedArtifactId}
      </output>
      <GridInteractionArtifactListSurface
        artifacts={genericArtifacts.slice(0, 3)}
        onOpenArtifact={(artifact) => setOpenedArtifactId(artifact.id)}
        showDateRangeControl={false}
        showSummaryCards={false}
      />
    </main>
  );
}

export const NativeDrag: Story = {
  args: { table: null, toolbar: null },
  tags: ["!stable", "preview"],
  render: () => <PointerContractGridStory />,
};

type PointerContractRow = { id: string; name: string };

const POINTER_CONTRACT_COLUMNS: readonly GridTableV2Column[] = [
  { id: "name", label: "Name" },
];
const POINTER_ALPHA: PointerContractRow = {
  id: "pointer-alpha",
  name: "Alpha",
};
const POINTER_BETA: PointerContractRow = {
  id: "pointer-beta",
  name: "Beta",
};
const POINTER_CONTRACT_GROUPS: readonly GridTableV2Group<PointerContractRow>[] =
  [
    { items: [POINTER_ALPHA], key: "active", label: "Active" },
    { items: [POINTER_BETA], key: "done", label: "Done" },
  ];

function PointerContractGridStory() {
  const [moves, setMoves] = useState(0);
  return (
    <GridInteractionContract>
      <div>
        <span className="sr-only" data-testid="pointer-contract-moves">
          {moves}
        </span>
        <GridTableV2<PointerContractRow>
          columns={POINTER_CONTRACT_COLUMNS}
          getRowId={(row) => row.id}
          gridTemplateColumns="minmax(200px, 1fr) 160px"
          groups={[...POINTER_CONTRACT_GROUPS]}
          items={[]}
          leadingLabel="Name"
          mode={GridTableV2Mode.Expanded}
          onGroupDrop={() => setMoves((count) => count + 1)}
          renderCell={(_columnId, row) => (
            <input aria-label={`Edit ${row.name}`} defaultValue={row.name} />
          )}
          renderLead={(row) => (
            <div className="flex items-center gap-2">
              <GridRowDragHandle aria-label={`Drag to reorder ${row.name}`} />
              <button type="button">{row.name}</button>
            </div>
          )}
        />
      </div>
    </GridInteractionContract>
  );
}

function createPointerContractDataTransfer() {
  const data = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "none",
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => data.set(type, value),
    types: [] as string[],
  };
}

function pointerContractEvent(
  pointerId: number,
  clientX: number,
  clientY: number
) {
  return { button: 0, clientX, clientY, pointerId, pointerType: "mouse" };
}
