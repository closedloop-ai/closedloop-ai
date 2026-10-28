"use client";

// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list controls.

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { Switch } from "@closedloop-ai/design-system/components/ui/switch";
import { PlusIcon, RotateCcwIcon, Settings2Icon } from "lucide-react";
import type { ReactNode } from "react";
import type { TableToggleOption } from "./table-toolbar-model";

/**
 * The toolbar's Options control: which summary metric cards and which table
 * columns are visible.
 *
 * Both sections are switch rows rather than checkbox menu items because they
 * are SETTINGS, not commands — the menu stays open as the user flips several,
 * and a switch reads as persistent state where a checkmark reads as a
 * selection. `TableOptionsSwitchRow` is exported so the compact menu folds the
 * same rows into its own surface instead of a second implementation.
 *
 * Toggles are reported one key at a time (`onToggleMetric` / `onToggleColumn`)
 * rather than by handing back a whole Set. The prototype passed
 * `React.Dispatch<SetStateAction<Set<string>>>` straight through, which forced
 * every caller to store visibility as a `Set` in `useState` — a real constraint
 * for a surface persisting column visibility as a saved view or a URL param.
 */
export function TableOptionsMenu({
  align = "start",
  columns,
  trailing,
  metrics,
  onAddField,
  onToggleColumn,
  onToggleMetric,
  visibleColumnIds,
  visibleMetricKeys,
}: {
  align?: "start" | "center" | "end";
  /** Every toggleable column, in the order the menu should list them. */
  columns: readonly TableToggleOption[];
  /**
   * Open the add-custom-field flow. Omit for a table whose columns are fixed;
   * the item is then not rendered.
   *
   * The wide menu and `TableCompactViewMenu` take the SAME prop because they are
   * the same capability at two widths. A control offered in only one of them
   * disappears at the `md` boundary, which reads as the product losing a feature
   * when the window narrows rather than as a smaller layout.
   *
   * THIS IS THE FALLBACK AFFORDANCE, NOT THE PREFERRED ONE. The Generic Artifact
   * prototype this family was extracted from puts Add field in a menu row ONLY
   * below `md`; at `md` and up it is a top-level toolbar button beside Options
   * (`artifact-shells.tsx`), because a one-click action buried under however many
   * column switches a table has is a demotion. A host with room should pass its
   * own button through `GridTableToolbar`'s `primary` slot and leave this
   * omitted; this row exists so the capability is reachable for a host that has
   * no room for one, not so every host buries it (design review).
   */
  onAddField?: () => void;
  /**
   * Items a surface appends below the column rows — an export action, a link
   * out. Rendered inside the menu content so a caller composes `DropdownMenu*`
   * primitives directly rather than this component growing a prop per action it
   * cannot know about. Omit for a menu of settings only.
   *
   * Named for the `trailing` slot `GridTableToolbar` and `SessionsToolbar`
   * already use, so this table family keeps one vocabulary for "appended here".
   */
  trailing?: ReactNode;
  /** Every toggleable summary metric card. Omit for a table with no metric row. */
  metrics?: readonly TableToggleOption[];
  onToggleColumn: (columnId: string) => void;
  onToggleMetric?: (metricKey: string) => void;
  visibleColumnIds: ReadonlySet<string>;
  visibleMetricKeys?: ReadonlySet<string>;
}) {
  const hasMetrics = metrics !== undefined && metrics.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2Icon />
          Options
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        collisionPadding={8}
        className="max-h-[min(var(--radix-dropdown-menu-content-available-height),60vh,620px)] w-72 overflow-y-auto p-2"
      >
        {hasMetrics ? (
          <>
            <DropdownMenuLabel className="text-muted-foreground">
              Summary cards
            </DropdownMenuLabel>
            {metrics.map((metric) => (
              <TableOptionsSwitchRow
                checked={visibleMetricKeys?.has(metric.key) ?? false}
                key={metric.key}
                label={metric.label}
                onChange={() => onToggleMetric?.(metric.key)}
              />
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel className="text-muted-foreground">
          Show / hide columns
        </DropdownMenuLabel>
        {columns.map((column) => (
          <TableOptionsSwitchRow
            checked={visibleColumnIds.has(column.key)}
            key={column.key}
            label={column.label}
            onChange={() => onToggleColumn(column.key)}
          />
        ))}
        {onAddField ? <TableAddFieldMenuItem onSelect={onAddField} /> : null}
        {trailing}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One switch row inside a table options menu. `onSelect` is prevented so
 * flipping a switch does not close the menu — a user hiding four columns should
 * not have to reopen it four times. The `Switch` itself is
 * `pointer-events-none` so the menu item owns the whole hit area and the two
 * cannot disagree about what a click meant.
 */
export function TableOptionsSwitchRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <DropdownMenuItem
      className="pl-2"
      onSelect={(event) => {
        event.preventDefault();
        onChange();
      }}
    >
      <span className="flex-1 truncate">{label}</span>
      <Switch checked={checked} className="pointer-events-none" />
    </DropdownMenuItem>
  );
}

/**
 * The "Add field" item some tables append to their options menu, exported so a
 * caller that supports user-defined columns can place it without re-deriving
 * the separator + icon treatment.
 */
export function TableAddFieldMenuItem({ onSelect }: { onSelect: () => void }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onSelect}>
        <PlusIcon />
        Add field
      </DropdownMenuItem>
    </>
  );
}

/**
 * The "Reset view" item, restoring a table's shipped default columns, order,
 * grouping and summary cards.
 *
 * A sibling of `TableAddFieldMenuItem` rather than a prop on the two menus,
 * because it is appended through the SAME `trailing` slot — which is what keeps
 * one composition passing it to both the wide and the compact menu, so the
 * action does not vanish at the `md` boundary.
 *
 * The default label matches `TableViewMenu`'s default `resetLabel`: this is the
 * v2 surface's home for the action the v1 View menu already offers, and two
 * spellings of one command is how a reader comes to think they are two.
 */
export function TableResetViewMenuItem({
  label = DEFAULT_RESET_VIEW_LABEL,
  onSelect,
}: {
  /**
   * Override for a table whose reset restores LESS than a whole view — the same
   * escape `TableViewMenu.resetLabel` already offers, so a surface that
   * deliberately named the action narrower does not silently widen its promise
   * on the way to v2. Beside a saved-view control, "Reset view" reads as
   * "discard the saved view", which is not what this command does.
   */
  label?: string;
  onSelect: () => void;
}) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onSelect}>
        <RotateCcwIcon />
        {label}
      </DropdownMenuItem>
    </>
  );
}

const DEFAULT_RESET_VIEW_LABEL = "Reset view";
