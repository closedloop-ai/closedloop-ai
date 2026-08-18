"use client";

import { AgentComponentGroupBy } from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_AUTHORS_LABEL } from "@repo/app/agents/lib/agent-component-authors";
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
  // FEA-4098 (Slice 3): group by author, replacing Owner. FEA-4266: the visible
  // label is "Authors"; the enum member/value (`collaborators`) is unchanged.
  {
    value: AgentComponentGroupBy.Collaborators,
    label: AGENT_COMPONENT_AUTHORS_LABEL,
  },
  { value: AgentComponentGroupBy.Harness, label: "Harness" },
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
 * Show-hide-columns / Reset.
 *
 * ISS-4866 retired the metric-mode `Select` that used to sit beside it: its
 * second option ("Value Index") rendered the identical value, and a control
 * whose choice silently does nothing costs more trust than the control is
 * worth. The Metric column header names the unit instead, and carries the
 * what/how tooltip the picker used to stand in for. ISS-5366 removed the gate
 * that was hiding the picker, making its absence unconditional; a second mode
 * that actually computes something different brings its own control back.
 *
 * Wired to `useAgentComponentsViewState` — callers destructure
 * `{ groupBy, visibleColumns, toggleColumn, setGroupBy }` from the hook and
 * thread them through the props here.
 *
 * Do NOT import from `apps/prototypes` — the prototype stand-ins
 * (`agents-view-menu.tsx`, `column-view-menu.tsx`) are intentionally not ported.
 */
export function AgentsViewMenu({
  groupBy,
  onGroupByChange,
  visibleColumns,
  onToggleColumn,
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

  // The real design-system TableViewMenu: Group-by + Show/Hide columns + Reset.
  // Returned directly, not wrapped: the `flex items-center gap-2` row existed to
  // sit this menu beside the metric-mode Select, and with that control retired
  // (ISS-4866/ISS-5366) a flex row with one child and a gap distributes nothing.
  // The parent toolbar already owns the spacing.
  return (
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
  );
}
