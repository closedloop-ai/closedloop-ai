import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  GridEmptyValue,
  GridTable,
  GridTableCard,
  type GridTableCardField,
  type GridTableColumn,
  ROW_ACTIONS_COLUMN,
  ROW_ACTIONS_COLUMN_ID,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { TableGridHeaderAlign } from "@repo/design-system/components/ui/table-grid-header";
import { TableViewMenu } from "@repo/design-system/components/ui/table-view-menu";
import { orderColumns } from "@repo/design-system/lib/column-order";
import { cn } from "@repo/design-system/lib/utils";
import type { Meta, StoryObj } from "@storybook/react";
import { MonitorDotIcon, MoreHorizontalIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import {
  playColumnOrderAlignment,
  playKeyboardResize,
} from "./grid-table-play-helpers";

/**
 * Data-agnostic table built on `TableGridHeader` + a `grid min-w-fit` row.
 * Callers supply the row type, column descriptors, a CSS grid template, and
 * render functions for the leading cell and each data cell. The component owns
 * no scroll container — wrap it in a `min-w-fit` / `overflow-auto` host so the
 * sticky header and horizontal scroll resolve against that host.
 */
const meta = {
  title: "Design System/Data Display/Grid Table",
  component: GridTable,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof GridTable>;

export default meta;

type Story = StoryObj<typeof meta>;

type DemoRow = {
  id: string;
  name: string;
  subtitle: string;
  owner: string;
  status: "active" | "done" | "failed";
  model: string | null;
  cost: string | null;
};

const COLUMNS: readonly GridTableColumn[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
  { id: "model", label: "Model" },
  // A placeholder column: dimmed header + empty cells (e.g. not-yet-wired data).
  { id: "autonomy", label: "Autonomy", className: "opacity-50" },
  { id: "cost", label: "Cost" },
];

// ISS-5333: the same columns with the numeric one opted into `headerAlign` —
// see the `EndAlignedNumericColumn` story.
const END_ALIGNED_COLUMNS: readonly GridTableColumn[] = COLUMNS.map((column) =>
  column.id === "cost"
    ? { ...column, sortable: true, headerAlign: TableGridHeaderAlign.End }
    : column
);

const LEAD_TRACK = "minmax(280px, 1fr)";

/**
 * Each data column's starting pixel width, keyed by id.
 *
 * ISS-5333 (review): a MAP rather than a hand-written track string, because
 * `GridTable`'s resize wiring keys off exactly this shape — `columnWidths` is
 * what makes a column resizable at all, and the resizable stories need the same
 * numbers the static stories render. One source, so a story that resizes and a
 * story that does not cannot start from different widths.
 */
const COLUMN_WIDTHS_PX: Readonly<Record<string, number>> = {
  owner: 160,
  status: 120,
  model: 160,
  autonomy: 140, // placeholder column
  cost: 100,
};

/** The grid track string for a set of columns at the given widths. */
function buildGridTemplateColumns(
  columns: readonly GridTableColumn[],
  widths: Readonly<Record<string, number>>
): string {
  return [
    LEAD_TRACK,
    ...columns.map((column) => `${widths[column.id]}px`),
  ].join(" ");
}

const GRID_TEMPLATE_COLUMNS = buildGridTemplateColumns(
  COLUMNS,
  COLUMN_WIDTHS_PX
);

const ROWS: DemoRow[] = [
  {
    id: "ses_1",
    name: "agent/refactor-auth-guard",
    subtitle: "claude-opus-4-8",
    owner: "Parker Byrd",
    status: "active",
    model: "opus-4.8",
    cost: "$4.12",
  },
  {
    id: "ses_2",
    name: "agent/seed-generator",
    subtitle: "claude-sonnet-4-6",
    owner: "Alex Rivera",
    status: "done",
    model: "sonnet-4.6",
    cost: "$1.08",
  },
  {
    id: "ses_3",
    name: "fix/token-rounding",
    subtitle: "codex-mini",
    owner: "Sam Chen",
    status: "failed",
    model: null,
    cost: "$0.24",
  },
];

const STATUS_VARIANT: Record<
  DemoRow["status"],
  "default" | "secondary" | "destructive"
> = {
  active: "default",
  done: "secondary",
  failed: "destructive",
};

function renderCell(columnId: string, row: DemoRow): ReactNode {
  switch (columnId) {
    case "owner":
      return <span className="truncate text-sm">{row.owner}</span>;
    case "status":
      return <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>;
    case "model":
      return row.model ? (
        <span className="truncate text-sm">{row.model}</span>
      ) : (
        <GridEmptyValue />
      );
    case "autonomy":
      // Placeholder column — intentionally empty.
      return null;
    case "cost":
      return <span className="text-sm tabular-nums">{row.cost}</span>;
    default:
      return null;
  }
}

// ISS-5333: `cost: null` is the row that shows the right-aligned empty value.
const ROWS_WITH_UNAVAILABLE_COST: DemoRow[] = ROWS.map((row) =>
  row.id === "ses_3" ? { ...row, cost: null } : row
);

// ISS-5333: the right-aligned Cost cell — a value or a right-aligned em-dash.
function renderEndAlignedCost(row: DemoRow): ReactNode {
  if (row.cost === null) {
    return <GridEmptyValue alignEnd />;
  }
  return <span className="ml-auto text-sm tabular-nums">{row.cost}</span>;
}

/**
 * ISS-5333 — a numeric column right-aligned end to end.
 *
 * `headerAlign: End` on the column puts the HEADER label on the column's right
 * rail (it is applied to the header cell and, for a sortable column, to the
 * `flex-1` sort button inside it — a `justify-end` in `className` reaches only
 * the cell and is inert once that button consumes it). `alignEnd` on the body's
 * value and on `GridEmptyValue` is the matching half: a right-aligned header
 * over left-aligned values is worse than leaving both alone, and the em-dash
 * belongs under the digits it stands in for, not flush left of them.
 *
 * The `Model` column deliberately keeps its DEFAULT inline `GridEmptyValue` in
 * the same canvas, so both dash treatments are visible side by side.
 */
export const EndAlignedNumericColumn: Story = {
  render: () => (
    <main className="h-[400px] overflow-auto">
      <GridTable
        columns={END_ALIGNED_COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        items={ROWS_WITH_UNAVAILABLE_COST}
        leadingLabel="Name"
        onSort={() => undefined}
        renderCell={(columnId, row) =>
          columnId === "cost"
            ? renderEndAlignedCost(row)
            : renderCell(columnId, row)
        }
        renderLead={(row) => (
          <span className="truncate font-medium text-sm">{row.name}</span>
        )}
        sortBy="cost"
        sortDir="desc"
      />
    </main>
  ),
};

/**
 * Default: the table inside a full-bleed scroll host (`overflow-auto`), the way
 * a page renders it. Resize the viewport narrower than the column total to see
 * horizontal scroll with the header staying aligned to the body.
 */
export const Default: Story = {
  render: () => (
    <main className="h-[400px] overflow-auto">
      <GridTable
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        items={ROWS}
        leadingLabel="Name"
        renderCell={renderCell}
        renderLead={(row) => (
          <>
            <span className="truncate font-medium text-sm">{row.name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {row.subtitle}
            </span>
          </>
        )}
      />
    </main>
  ),
};

const ROW_ACTIONS_COLUMNS: readonly GridTableColumn[] = [
  ...COLUMNS,
  ROW_ACTIONS_COLUMN,
];

const ROW_ACTIONS_GRID_TEMPLATE_COLUMNS = [
  GRID_TEMPLATE_COLUMNS,
  "52px", // Row actions
].join(" ");

/**
 * Row actions: the trailing overflow-menu column every dense table ends with.
 * Spread the shared `ROW_ACTIONS_COLUMN` spec and add your own track width — the
 * id, the deliberately empty header label, and the accessible name are picked
 * once in the design system so no two tables name the same column differently.
 *
 * The header cell is blank on purpose (a label there is noise next to a kebab),
 * but the column still owns a grid track that every row's action cell is
 * announced against, so the spec carries an `ariaLabel`. Any column of yours
 * that ships without a visible label needs the same treatment — otherwise a
 * screen reader reads those cells under a nameless column.
 */
export const RowActions: Story = {
  render: () => (
    <main className="h-[400px] overflow-auto">
      <GridTable
        columns={ROW_ACTIONS_COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={ROW_ACTIONS_GRID_TEMPLATE_COLUMNS}
        items={ROWS}
        leadingLabel="Name"
        renderCell={(columnId, row) =>
          columnId === ROW_ACTIONS_COLUMN_ID ? (
            <Button
              aria-label={`${row.name} actions`}
              className="ml-auto"
              size="icon-sm"
              variant="ghost"
            >
              <MoreHorizontalIcon aria-hidden className="size-4" />
            </Button>
          ) : (
            renderCell(columnId, row)
          )
        }
        renderLead={(row) => (
          <>
            <span className="truncate font-medium text-sm">{row.name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {row.subtitle}
            </span>
          </>
        )}
      />
    </main>
  ),
};

const SORTABLE_COLUMNS: readonly GridTableColumn[] = [
  { id: "owner", label: "Owner", sortable: true },
  { id: "status", label: "Status", sortable: true },
  { id: "model", label: "Model", sortable: true },
  { id: "autonomy", label: "Autonomy", className: "opacity-50" },
  { id: "cost", label: "Cost", sortable: true },
];

/**
 * Sortable: pass `onSort` (+ `sortBy`/`sortDir`) and mark columns `sortable` to
 * get clickable headers with sort indicators. Click a header to cycle
 * descending → ascending. The leading column sorts via `leadingSortKey`.
 */
export const Sortable: Story = {
  render: () => {
    function SortableDemo() {
      const [sortBy, setSortBy] = useState<string | null>("owner");
      const [sortDir, setSortDir] = useState<SortDirection>("asc");
      const sortedRows = useMemo(() => {
        if (!sortBy) {
          return ROWS;
        }
        const factor = sortDir === "asc" ? 1 : -1;
        return [...ROWS].sort((a, b) => {
          const left = String(a[sortBy as keyof DemoRow] ?? "");
          const right = String(b[sortBy as keyof DemoRow] ?? "");
          return left.localeCompare(right) * factor;
        });
      }, [sortBy, sortDir]);

      return (
        <main className="h-[400px] overflow-auto">
          <GridTable
            columns={SORTABLE_COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
            items={sortedRows}
            leadingLabel="Name"
            leadingSortKey="name"
            onSort={(column, direction) => {
              setSortBy(column);
              setSortDir(direction);
            }}
            renderCell={renderCell}
            renderLead={(row) => (
              <>
                <span className="truncate font-medium text-sm">{row.name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.subtitle}
                </span>
              </>
            )}
            sortBy={sortBy}
            sortDir={sortDir}
          />
        </main>
      );
    }
    return <SortableDemo />;
  },
};

/**
 * Grouped: pass `groups` (and an optional `groupIcon`) to render collapsible
 * `GroupSectionHeader` sections within a single table — one shared column
 * header. Click a section header to collapse/expand it.
 */
export const Grouped: Story = {
  render: () => (
    <main className="h-[400px] overflow-auto">
      <GridTable
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        groupIcon={<MonitorDotIcon className="size-4 text-muted-foreground" />}
        groups={[
          {
            key: "active",
            label: "Active",
            items: ROWS.filter((r) => r.status === "active"),
          },
          {
            key: "done",
            label: "Done",
            items: ROWS.filter((r) => r.status === "done"),
          },
          {
            key: "failed",
            label: "Failed",
            items: ROWS.filter((r) => r.status === "failed"),
          },
        ]}
        items={ROWS}
        leadingLabel="Name"
        renderCell={renderCell}
        renderLead={(row) => (
          <span className="truncate font-medium text-sm">{row.name}</span>
        )}
      />
    </main>
  ),
};

function renderDemoCard(row: DemoRow, columns: readonly GridTableColumn[]) {
  const fields: GridTableCardField[] = columns
    // Status leads the header, the placeholder column carries no value — neither
    // belongs in the card body.
    .filter((column) => column.id !== "status" && column.id !== "autonomy")
    .map((column) => ({
      key: column.id,
      label: column.label,
      value: renderCell(column.id, row),
    }));
  return (
    <GridTableCard
      fields={fields}
      header={
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="truncate font-medium text-sm">{row.name}</span>
          <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
        </div>
      }
    />
  );
}

/**
 * Responsive card fallback (FEA-3865): pass `cardRender` and the table drops to
 * a stacked card list below the `md` breakpoint (768px), and renders the CSS
 * grid at `md+`. The table measures its own container width, so this story's
 * `max-w-md` frame renders cards; widen the frame past 768px to watch it hand
 * off to the grid. Desktop widths are unchanged, the grid still renders.
 */
export const Cards: Story = {
  render: () => (
    <main className="h-[520px] max-w-md overflow-auto">
      <GridTable
        cardRender={renderDemoCard}
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        items={ROWS}
        leadingLabel="Name"
        renderCell={renderCell}
        renderLead={(row) => (
          <>
            <span className="truncate font-medium text-sm">{row.name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {row.subtitle}
            </span>
          </>
        )}
      />
    </main>
  ),
};

/**
 * Empty state: header only, no rows. Hosts typically render their own
 * empty/loading state in place of the table when there are no items.
 */
export const Empty: Story = {
  render: () => (
    <main className="h-[200px] overflow-auto">
      <GridTable
        columns={COLUMNS}
        getRowId={(row) => row.id}
        gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
        items={[]}
        leadingLabel="Name"
        renderCell={renderCell}
        renderLead={(row) => <span>{row.name}</span>}
      />
    </main>
  ),
};

/**
 * Whole-column fold fitting (ISS-4889). Both frames below are the SAME table at
 * the SAME width — a `max-w-2xl` (672px) host against a 960px template — so the
 * only difference is the `snapFoldToColumns` opt-in.
 *
 * Without it the fold (the host's right edge, at rest) lands wherever it lands:
 * the declared boundaries are 280 / 440 / 560 / 720, so `Model` starts at 560
 * and runs to 720, and 112px of a 160px track is rendered — a chip clipped to
 * half a word, or, on a money column, `$772.39` reading as `$772.3` (ISS-4788).
 *
 * With it the leading track absorbs the 112px left over after the last WHOLE
 * column, so the boundaries become 392 / 552 / 672 and the fold IS a boundary —
 * `Status` ends exactly at the host's edge. Nothing is hidden, dropped, or
 * reordered: `Model`, `Autonomy` and `Cost` are one scroll away at their exact
 * declared widths, which is why every data track is byte-identical between the
 * two frames and only the lead is wider.
 *
 * The guarantee holds at rest (`scrollLeft` 0). Scroll either frame right and
 * tracks straddle the LEFT edge again, as in any horizontally-scrolling table.
 * Drag the Storybook viewport narrower to watch the lead stretch and re-snap as
 * each column crosses the fold.
 */
export const WholeColumnFold: Story = {
  render: () => (
    <main className="flex flex-col gap-6 p-4">
      <section aria-labelledby="fold-off-heading" className="flex flex-col">
        <h3 className="pb-2 font-medium text-sm" id="fold-off-heading">
          Default — the fold cuts through <code>Model</code>
        </h3>
        <p className="pb-2 text-muted-foreground text-xs">
          Tracks 280 / 160 / 120 / 160 … against a 672px host: the third data
          column is rendered 112px wide instead of 160px.
        </p>
        <div className="max-w-2xl overflow-auto rounded-md border">
          <GridTable
            columns={COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
            items={ROWS}
            leadingLabel="Name"
            renderCell={renderCell}
            renderLead={(row) => (
              <span className="truncate font-medium text-sm">{row.name}</span>
            )}
          />
        </div>
      </section>
      <section aria-labelledby="fold-on-heading" className="flex flex-col">
        <h3 className="pb-2 font-medium text-sm" id="fold-on-heading">
          <code>snapFoldToColumns</code> — the fold is a column boundary
        </h3>
        <p className="pb-2 text-muted-foreground text-xs">
          The lead absorbs the 112px leftover (280 → 392px); every data track
          keeps its declared width and <code>Status</code> ends exactly on the
          edge.
        </p>
        <div className="max-w-2xl overflow-auto rounded-md border">
          <GridTable
            columns={COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns={GRID_TEMPLATE_COLUMNS}
            items={ROWS}
            leadingLabel="Name"
            renderCell={renderCell}
            renderLead={(row) => (
              <span className="truncate font-medium text-sm">{row.name}</span>
            )}
            snapFoldToColumns
          />
        </div>
      </section>
    </main>
  ),
};

// FEA-4021: width-carrying specs so a reorder / show-hide moves a column AND its
// grid track together. The lead column ("Name") is fixed and never reorders — it
// uses the shared `LEAD_TRACK` declared above rather than a second copy of the
// same literal (ISS-5333 review: the duplicate was invisible until both were in
// scope at once).
const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "owner", label: "Owner", width: "160px", sortable: true },
  { id: "status", label: "Status", width: "120px", sortable: true },
  { id: "model", label: "Model", width: "160px", sortable: true },
  { id: "cost", label: "Cost", width: "100px", sortable: true },
];
const SPEC_BY_ID = new Map(COLUMN_SPECS.map((spec) => [spec.id, spec]));

/**
 * Reorderable + show/hide columns (FEA-4021). Pass `columnOrder` +
 * `onColumnOrderChange` to get a drag handle on each data-column header (drag
 * with a pointer, or focus a handle and press ArrowLeft/ArrowRight). The
 * companion `TableViewMenu` (the same generic View menu the product toolbars
 * use) toggles which columns render; the caller drops a hidden column's grid
 * track in lockstep because the `gridTemplateColumns` string cannot be sliced
 * generically. Column headers are also sortable — all three behaviors compose
 * on one table. ISS-5812: a reorderable column reserves NO extra room — its
 * cells carry the same `pl-3` as every other column's. The pointer drag target
 * is the HEADER CELL itself, and the reveal-on-hover grip is the visual cue plus
 * the keyboard control (`pointer-events-none`), which is why it can sit in the
 * divider seam without fighting the previous column's resize strip for the
 * pointer. `InteractiveV2` is where that separation is actually visible, since
 * it wires reorder and the v2 resize strip on the same table.
 */
export const ReorderableAndHideable: Story = {
  render: () => {
    function ControlsDemo() {
      const [order, setOrder] = useState<string[]>(
        COLUMN_SPECS.map((spec) => spec.id)
      );
      const [hidden, setHidden] = useState<Set<string>>(() => new Set());
      const [sortBy, setSortBy] = useState<string | null>(null);
      const [sortDir, setSortDir] = useState<SortDirection>("asc");

      const visibleSpecs = useMemo(() => {
        const ordered = order
          .map((id) => SPEC_BY_ID.get(id))
          .filter(
            (spec): spec is (typeof COLUMN_SPECS)[number] => spec != null
          );
        return orderColumns(ordered, order).filter(
          (spec) => !hidden.has(spec.id)
        );
      }, [order, hidden]);

      const columns: GridTableColumn[] = visibleSpecs.map(
        ({ width, ...column }) => column
      );
      const gridTemplateColumns = [
        LEAD_TRACK,
        ...visibleSpecs.map((spec) => spec.width),
      ].join(" ");

      return (
        <div className="flex flex-col gap-2">
          <div className="flex justify-end px-3 pt-3">
            <TableViewMenu
              align="end"
              columns={COLUMN_SPECS.map((spec) => ({
                id: spec.id,
                label: spec.label,
                visible: !hidden.has(spec.id),
              }))}
              onResetView={() => setHidden(new Set())}
              onToggleColumn={(id) =>
                setHidden((prev) => {
                  const next = new Set(prev);
                  if (next.has(id)) {
                    next.delete(id);
                  } else {
                    next.add(id);
                  }
                  return next;
                })
              }
            />
          </div>
          <main className="h-[400px] overflow-auto">
            <GridTable
              columnOrder={visibleSpecs.map((spec) => spec.id)}
              columns={columns}
              getRowId={(row) => row.id}
              gridTemplateColumns={gridTemplateColumns}
              items={ROWS}
              leadingLabel="Name"
              leadingSortKey="name"
              onColumnOrderChange={setOrder}
              onSort={(column, direction) => {
                setSortBy(column);
                setSortDir(direction);
              }}
              renderCell={renderCell}
              renderLead={(row) => (
                <span className="truncate font-medium text-sm">{row.name}</span>
              )}
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </main>
        </div>
      );
    }
    return <ControlsDemo />;
  },
  play: ({ canvasElement }) => playColumnOrderAlignment(canvasElement),
};

/**
 * GridTable v2 — the interaction pass hoisted from the `generic-artifact`
 * prototype, behind the shared `grid-table-v2` flag in production.
 *
 * What to look for (these are the acceptance criteria, not decoration):
 *  - Hover a column header: the sort caret and the options chevron fade in. Tab
 *    to them instead and they appear the same way — every hover reveal has a
 *    `focus-visible` twin, so nothing here is mouse-only.
 *  - Open a column menu, then move the pointer off the header: the chevron
 *    STAYS visible while its menu is open rather than vanishing underneath it.
 *  - Click a row: it selects, AND focus lands on the cell you clicked. Arrow
 *    keys then walk the grid from there; the selected row keeps its tint as the
 *    pointer crosses it instead of flickering to the hover grey.
 *  - Drag a column's grip: the dragged header fades and the header you are over
 *    shows an insertion rule.
 *  - Drag a column's right edge: the hairline lights up and the col-resize
 *    cursor holds for the whole drag, not just while over the 12px strip.
 *  - ISS-5356 — hover the boundary between two columns and move right across
 *    it: the cursor is `col-resize` over the resize strip, and it becomes
 *    `grab` only once you are past the strip and onto the grip. There is no
 *    overlap where the dots are showing but the pointer still resizes the
 *    column to the LEFT. This story is the visual pin for that, because it is
 *    the only one wiring reorder and the v2 resize strip on the same table.
 */
export const InteractiveV2: Story = {
  render: () => {
    function InteractiveDemo() {
      const [selectedId, setSelectedId] = useState<string | null>("ses_2");
      const [sortBy, setSortBy] = useState<string | null>("owner");
      const [sortDir, setSortDir] = useState<SortDirection>("asc");
      const [columnOrder, setColumnOrder] = useState<string[]>(
        COLUMNS.map((column) => column.id)
      );
      // ISS-5333 (review): this story's own docstring promised "drag a column's
      // right edge", but it never wired `columnWidths`/`onColumnWidthChange` —
      // and `GridTable` derives `resize.columnIds` from `Object.keys(columnWidths)`,
      // so with the map absent NO resize handle rendered anywhere in Storybook
      // and the v2 hairline variant was unreachable. Seeded here, so the prose
      // and the canvas agree.
      const [columnWidths, setColumnWidths] =
        useState<Record<string, number>>(COLUMN_WIDTHS_PX);
      const [lastAction, setLastAction] = useState("—");
      const columns = useMemo(
        () =>
          COLUMNS.map((column) => ({
            ...column,
            sortable: column.id !== "autonomy",
            filterable: column.id === "owner" || column.id === "status",
            groupable: column.id === "status",
            movable: true,
          })),
        []
      );
      const orderedColumns = orderColumns(columns, columnOrder);
      return (
        <main className="flex h-[420px] flex-col">
          <p className="border-b px-4 py-2 text-muted-foreground text-xs">
            Last column action:{" "}
            <span className="font-medium">{lastAction}</span>
          </p>
          <div className="min-h-0 flex-1 overflow-auto">
            <GridTable
              columnOrder={columnOrder}
              columns={orderedColumns}
              columnWidths={columnWidths}
              enhancedHeaderInteractions
              getRowId={(row) => row.id}
              gridTemplateColumns={buildGridTemplateColumns(
                orderedColumns,
                columnWidths
              )}
              headerActions={{
                onFilter: (columnId) => setLastAction(`filter ${columnId}`),
                onGroup: (columnId) => setLastAction(`group ${columnId}`),
                onMove: (columnId, direction) =>
                  setLastAction(`move ${columnId} ${direction}`),
              }}
              isRowSelected={(row) => row.id === selectedId}
              items={ROWS}
              keyboardCellNavigation
              leadingLabel="Name"
              onColumnOrderChange={setColumnOrder}
              onColumnWidthChange={(columnId, widthPx) => {
                setColumnWidths((previous) => ({
                  ...previous,
                  [columnId]: widthPx,
                }));
                setLastAction(`resize ${columnId} → ${widthPx}px`);
              }}
              onRowClick={(row) => setSelectedId(row.id)}
              onSort={(column, direction) => {
                setSortBy(column);
                setSortDir(direction);
              }}
              renderCell={renderCell}
              renderLead={(row) => (
                <>
                  <span className="truncate font-medium text-sm">
                    {row.name}
                  </span>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {row.subtitle}
                  </span>
                </>
              )}
              sortBy={sortBy}
              sortDir={sortDir}
            />
          </div>
        </main>
      );
    }
    return <InteractiveDemo />;
  },
};

/**
 * The same table with a leading utility column — a row checkbox occupying the
 * FIRST grid track, ahead of the identity cell. The caller adds the matching
 * track to `gridTemplateColumns`; the table shifts every `aria-colindex` by one
 * on both the header and the body so the two stay paired.
 */
export const LeadingUtilityColumn: Story = {
  render: () => {
    function UtilityDemo() {
      const [checked, setChecked] = useState<Set<string>>(
        () => new Set(["ses_2"])
      );
      const toggle = (id: string) =>
        setChecked((previous) => {
          const next = new Set(previous);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
      return (
        <main className="h-[400px] overflow-auto">
          <GridTable
            columns={COLUMNS}
            getRowId={(row) => row.id}
            gridTemplateColumns={`44px ${GRID_TEMPLATE_COLUMNS}`}
            isRowSelected={(row) => checked.has(row.id)}
            items={ROWS}
            leadingLabel="Name"
            leadingUtilityHeader={
              <Checkbox
                aria-label="Select all rows"
                checked={checked.size === ROWS.length}
                onCheckedChange={(next) =>
                  setChecked(
                    next === true
                      ? new Set(ROWS.map((row) => row.id))
                      : new Set()
                  )
                }
              />
            }
            renderCell={renderCell}
            renderLead={(row) => (
              <span className="truncate font-medium text-sm">{row.name}</span>
            )}
            renderLeadingUtility={(row) => (
              <span data-row-selection-surface>
                <Checkbox
                  aria-label={`Select ${row.name}`}
                  checked={checked.has(row.id)}
                  onCheckedChange={() => toggle(row.id)}
                />
              </span>
            )}
          />
        </main>
      );
    }
    return <UtilityDemo />;
  },
};

/**
 * ISS-5333 (review) — column resize in the PRE-v2 presentation.
 *
 * `InteractiveV2` above covers the v2 handle (a 12px hit strip whose visual is a
 * decoupled `after:` hairline). This is the other variant, and the one every
 * table that has not opted into `enhancedHeaderInteractions` actually renders
 * today: a narrow strip carrying a visible on-token divider bar, revealed on
 * header hover or keyboard focus.
 *
 * Neither variant used to render anywhere in Storybook, because a resize handle
 * only exists when the caller seeds `columnWidths` — `GridTable` derives
 * `resize.columnIds` from `Object.keys(columnWidths)` — and no story did.
 *
 * Keyboard: focus a column's resize handle and press ArrowLeft/ArrowRight to
 * step its width; the announced name says so (WCAG 2.1.1).
 */
export const ResizableColumns: Story = {
  render: () => {
    function ResizeDemo() {
      const [columnWidths, setColumnWidths] =
        useState<Record<string, number>>(COLUMN_WIDTHS_PX);
      const [lastAction, setLastAction] = useState("—");
      return (
        <main className="flex h-[400px] flex-col">
          <p className="border-b px-4 py-2 text-muted-foreground text-xs">
            Last resize: <span className="font-medium">{lastAction}</span>
          </p>
          <div className="min-h-0 flex-1 overflow-auto">
            <GridTable
              columns={COLUMNS}
              columnWidths={columnWidths}
              getRowId={(row) => row.id}
              gridTemplateColumns={buildGridTemplateColumns(
                COLUMNS,
                columnWidths
              )}
              items={ROWS}
              leadingLabel="Name"
              onColumnWidthChange={(columnId, widthPx) => {
                setColumnWidths((previous) => ({
                  ...previous,
                  [columnId]: widthPx,
                }));
                setLastAction(`${columnId} → ${widthPx}px`);
              }}
              renderCell={renderCell}
              renderLead={(row) => (
                <span className="truncate font-medium text-sm">{row.name}</span>
              )}
            />
          </div>
        </main>
      );
    }
    return <ResizeDemo />;
  },
  play: ({ canvasElement }) => playKeyboardResize(canvasElement),
};
