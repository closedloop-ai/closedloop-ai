import { Badge } from "@repo/design-system/components/ui/badge";
import {
  GridEmptyValue,
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { Meta, StoryObj } from "@storybook/react";
import { MonitorDotIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

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
  cost: string;
};

const COLUMNS: readonly GridTableColumn[] = [
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
  { id: "model", label: "Model" },
  // A placeholder column: dimmed header + empty cells (e.g. not-yet-wired data).
  { id: "autonomy", label: "Autonomy", className: "opacity-50" },
  { id: "cost", label: "Cost" },
];

const GRID_TEMPLATE_COLUMNS = [
  "minmax(280px, 1fr)", // leading cell
  "160px", // Owner
  "120px", // Status
  "160px", // Model
  "140px", // Autonomy (placeholder)
  "100px", // Cost
].join(" ");

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
