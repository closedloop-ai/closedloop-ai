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

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
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
import { GridTableV2 } from "@repo/design-system/components/ui/grid-table-v2";
import { GridTableV2Card } from "@repo/design-system/components/ui/grid-table-v2-card";
import { Input } from "@repo/design-system/components/ui/input";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import { CARD_FALLBACK_BREAKPOINT } from "@repo/design-system/lib/column-order";
import type { Meta, StoryObj } from "@storybook/react";
import { AlertCircleIcon, InboxIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import {
  FrozenGridTableListSurface,
  FrozenGridTableV2,
} from "./support/frozen-grid-table-v2-card-list";

const meta = {
  title: "Primitives v1.0/Data Display/Tables/Grid Table List Surface",
  component: GridTableListSurface,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof GridTableListSurface>;

// No controls: each story fixes a complete band and row fixture, while callbacks and slots are parent-driven.

export default meta;

type Story = StoryObj<typeof meta>;

const TOOLBAR_LABEL = "Filter artifacts";
const METRIC_LABELS = ["Artifacts", "Token spend", "Creation cost"];
const ROW_LABELS = ["Alpha", "Bravo", "Charlie"];

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

/** One measured compact answer drives both toolbar and real card body. */
export const MeasuredCompact: Story = {
  args: { table: null, toolbar: null },
  render: () => (
    <MeasuredListSurfaceStory initialWidth={CARD_FALLBACK_BREAKPOINT - 1} />
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
    await expect(canvas.getByRole("button", { name: "View" })).toBeVisible();
    await expect(canvas.getByText("Ada Lovelace")).toBeVisible();
    await expect(canvas.queryByRole("grid")).toBeNull();
  },
};

/** At the exact boundary the expanded toolbar and full grid mount together. */
export const MeasuredExpanded: Story = {
  args: { table: null, toolbar: null },
  render: () => (
    <MeasuredListSurfaceStory initialWidth={CARD_FALLBACK_BREAKPOINT} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const host = canvas.getByTestId("grid-table-measured-width-host");
    await expect(host).toHaveStyle({ width: `${CARD_FALLBACK_BREAKPOINT}px` });
    if (!hasBrowserLayout(host)) {
      return;
    }
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
    await expect(canvas.getByRole("grid")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "View" })).toBeNull();
  },
};

/** A focused card action lands on the host region after crossing to the grid. */
export const MeasuredFocusHandoff: Story = {
  args: { table: null, toolbar: null },
  render: () => (
    <MeasuredListSurfaceStory initialWidth={CARD_FALLBACK_BREAKPOINT - 1} />
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
    await userEvent.click(canvas.getByRole("button", { name: "Alpha" }));
    await expect(host).toHaveStyle({ width: `${CARD_FALLBACK_BREAKPOINT}px` });
    await expect(canvas.getByRole("grid")).toBeVisible();
    await expect(canvas.getByRole("region", { name: "Rows" })).toHaveFocus();
  },
};

const LOADING_LABEL = "Loading artifacts";
const EMPTY_TITLE = "No artifacts yet";
const ERROR_TITLE = "Could not load artifacts";
const RETRY_LABEL = "Try again";

type SurfaceState = "loaded" | "loading" | "empty" | "error";

function ListSurfaceStory({
  metrics = <StoryMetrics />,
  pagination = <StoryPagination />,
  state = "loaded",
}: {
  metrics?: ReactNode;
  pagination?: ReactNode;
  state?: SurfaceState;
}) {
  // Held as state so the error node's retry is a REAL transition. A control the
  // host renders enabled but wires to nothing is a UI lying about what it can
  // do, and a story asserting only that it is enabled asserts nothing.
  const [surfaceState, setSurfaceState] = useState<SurfaceState>(state);
  const isLoaded = surfaceState === "loaded";

  return (
    <main className="flex h-screen flex-col bg-background">
      <GridTableListSurface
        className="flex-1 rounded-md border"
        metrics={metrics}
        pagination={isLoaded ? pagination : null}
        table={
          <StoryTable
            onRetry={() => setSurfaceState("loaded")}
            state={surfaceState}
          />
        }
        toolbar={<StoryToolbar />}
      />
    </main>
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

function MeasuredListSurfaceStory({ initialWidth }: { initialWidth: number }) {
  const [contentWidth, setContentWidth] = useState(initialWidth);

  return (
    <div
      data-testid="grid-table-measured-width-host"
      style={{ width: contentWidth }}
    >
      <FrozenGridTableListSurface
        table={(mode) => (
          <FrozenGridTableV2
            cardRender={(row: (typeof MEASURED_ROWS)[number]) => (
              <GridTableV2Card
                fields={[{ key: "owner", label: "Owner", value: row.owner }]}
                header={
                  <button
                    onClick={() =>
                      setContentWidth(
                        mode === "compact"
                          ? CARD_FALLBACK_BREAKPOINT
                          : CARD_FALLBACK_BREAKPOINT - 1
                      )
                    }
                    type="button"
                  >
                    {row.name}
                  </button>
                }
              />
            )}
            columns={[{ id: "owner", label: "Owner" }]}
            getRowId={(row) => row.id}
            gridTemplateColumns="minmax(12rem,1fr) minmax(8rem,1fr)"
            items={MEASURED_ROWS}
            leadingLabel="Name"
            mode={mode}
            renderCell={(_columnId, row) => row.owner}
            renderLead={(row) => (
              <button
                onClick={() =>
                  setContentWidth(
                    mode === "compact"
                      ? CARD_FALLBACK_BREAKPOINT
                      : CARD_FALLBACK_BREAKPOINT - 1
                  )
                }
                type="button"
              >
                {row.name}
              </button>
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
