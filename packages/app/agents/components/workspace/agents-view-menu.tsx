"use client";

import {
  AgentComponentGroupBy,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  TableViewMenu,
  type TableViewMenuColumn,
} from "@repo/design-system/components/ui/table-view-menu";
import {
  AGENT_COMPONENT_TOGGLEABLE_COLUMNS,
  type AgentComponentColumnId,
} from "../../hooks/use-agent-components-view-state";

// ---------------------------------------------------------------------------
// Group-by options — match the AgentComponentGroupBy enum values exactly.
// ---------------------------------------------------------------------------

const GROUP_BY_OPTIONS = [
  { value: AgentComponentGroupBy.None, label: "None" },
  { value: AgentComponentGroupBy.Type, label: "Type" },
  { value: AgentComponentGroupBy.Owner, label: "Owner" },
  { value: AgentComponentGroupBy.Harness, label: "Harness" },
] as const;

// ---------------------------------------------------------------------------
// Metric-mode options — match the AgentMetricMode enum values exactly.
// ---------------------------------------------------------------------------

const METRIC_MODE_OPTIONS = [
  { value: AgentMetricMode.KlocPerDollar, label: "KLOC / $" },
  { value: AgentMetricMode.DollarPerKloc, label: "$ / KLOC" },
  { value: AgentMetricMode.ValueIndex, label: "Value Index" },
] as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type AgentsViewMenuProps = Readonly<{
  /** Current group-by dimension. */
  groupBy: AgentComponentGroupBy;
  /** Called when the user selects a different group-by dimension. */
  onGroupByChange: (value: AgentComponentGroupBy) => void;
  /**
   * Currently visible column ids — used to derive the `visible` flag on each
   * column entry passed to TableViewMenu.
   */
  visibleColumns: ReadonlySet<string>;
  /** Called when the user toggles a column's visibility. */
  onToggleColumn: (id: AgentComponentColumnId) => void;
  /** Current metric display mode. */
  metricMode: AgentMetricMode;
  /** Called when the user selects a different metric mode. */
  onMetricModeChange: (mode: AgentMetricMode) => void;
  /** Called when the user clicks "Reset view". */
  onReset: () => void;
  /** Popover edge alignment forwarded to TableViewMenu. Defaults to "end". */
  align?: "start" | "end";
}>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * T-3.3 — Agents workspace View menu adapter.
 *
 * Composes the real `@repo/design-system` `TableViewMenu` for Group-by /
 * Show-hide-columns / Reset, and adds a metric-mode `Select` (KLOC/$,
 * $/KLOC, Value Index) as a companion control.
 *
 * Wired to `useAgentComponentsViewState` — callers destructure
 * `{ groupBy, visibleColumns, toggleColumn, metricMode, setGroupBy,
 *   setMetricMode }` from the hook and thread them through the props here.
 *
 * Do NOT import from `apps/prototypes` — the prototype stand-ins
 * (`agents-view-menu.tsx`, `column-view-menu.tsx`) are intentionally not ported.
 */
export function AgentsViewMenu({
  groupBy,
  onGroupByChange,
  visibleColumns,
  onToggleColumn,
  metricMode,
  onMetricModeChange,
  onReset,
  align = "end",
}: AgentsViewMenuProps) {
  // Map AGENT_COMPONENT_TOGGLEABLE_COLUMNS to the shape TableViewMenu expects.
  const columns: TableViewMenuColumn[] = AGENT_COMPONENT_TOGGLEABLE_COLUMNS.map(
    (column) => ({
      id: column.id,
      label: column.label,
      visible: visibleColumns.has(column.id),
    })
  );

  return (
    <div className="flex items-center gap-2">
      {/* Metric-mode selector — companion to TableViewMenu, not a slot inside it. */}
      <Select
        onValueChange={(value) => {
          onMetricModeChange(value as AgentMetricMode);
        }}
        value={metricMode}
      >
        <SelectTrigger className="h-8 w-[130px] shadow-none" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {METRIC_MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Real design-system TableViewMenu: Group-by + Show/Hide columns + Reset. */}
      <TableViewMenu
        align={align}
        columns={columns}
        groupByOptions={[...GROUP_BY_OPTIONS]}
        groupByValue={groupBy}
        onChangeGroupBy={(value) => {
          onGroupByChange(value as AgentComponentGroupBy);
        }}
        onResetView={onReset}
        onToggleColumn={(id) => {
          onToggleColumn(id as AgentComponentColumnId);
        }}
      />
    </div>
  );
}
