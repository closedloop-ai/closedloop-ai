"use client";

// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list controls.

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  Layers2Icon,
  PlusIcon,
  Settings2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  TableAddFieldMenuItem,
  TableOptionsSwitchRow,
} from "./table-options-menu-v2";
import {
  appendTableSort,
  removeTableSort,
  resolveFieldLabel,
  setTableSortDirection,
  setPrimaryGroupingField,
  type TableFieldOption,
  type TableGroupingState,
  type TableSortRule,
  type TableToggleOption,
} from "./table-toolbar-model";

/**
 * Radio value standing in for "no selection". A radio group needs a string for
 * every state including the empty one, while the toolbar model uses `null`.
 */
const NO_SELECTION_VALUE = "none";

/**
 * The single menu the toolbar folds Sort + Grouping + Summary cards +
 * Show/hide columns into below the `md` breakpoint.
 *
 * This is a DIFFERENT control from the four it replaces, not those four made
 * smaller, and that is deliberate. On a phone there is no room for four
 * triggers, and the popover-shaped grouping editor (a five-column grid with
 * drag handles) has nowhere to open. So the narrow layout trades the editor for
 * one-level-at-a-time radio submenus: less capable, entirely reachable. The
 * secondary group's order and empty-group visibility are only editable in the
 * wide layout — a phone can still SEE a two-level grouping applied elsewhere and
 * change either level's field, which is the part that matters on a small screen.
 *
 * It shares `TableOptionsSwitchRow` with `TableOptionsMenu` so the metric and
 * column rows cannot drift between the two widths.
 */
export function TableCompactViewMenu({
  align = "end",
  columns,
  grouping,
  groupOptions,
  maxSortRules,
  metrics,
  onAddField,
  onClearSort,
  onGroupingChange,
  onSort,
  onSortsChange,
  onToggleColumn,
  onToggleMetric,
  sortBy,
  sortOptions,
  sorts,
  trailing,
  visibleColumnIds,
  visibleMetricKeys,
}: {
  align?: "start" | "center" | "end";
  columns: readonly TableToggleOption[];
  /** Omit the grouping trio when the surface supports sorting but not grouping. */
  grouping?: TableGroupingState;
  groupOptions?: readonly TableFieldOption[];
  /** @see TableSortMenu.maxSortRules — the narrow half of the same cap. */
  maxSortRules?: number;
  metrics?: readonly TableToggleOption[];
  /** Omit for a table whose columns are fixed; the item is then not rendered. */
  onAddField?: () => void;
  /**
   * Items a surface appends below the column rows — the same slot, by the same
   * name, as `TableOptionsMenu`'s. It exists here because this menu REPLACES
   * that one below `md` rather than sitting beside it: an export action passed
   * only to the wide menu is unreachable on a phone, which is the narrow layout
   * dropping a capability rather than folding it.
   */
  trailing?: ReactNode;
  onClearSort: () => void;
  onGroupingChange?: (next: TableGroupingState) => void;
  onSort?: (fieldId: string) => void;
  onSortsChange?: (sorts: readonly TableSortRule[]) => void;
  onToggleColumn: (columnId: string) => void;
  onToggleMetric?: (metricKey: string) => void;
  sortBy: string | null;
  sortOptions: readonly TableFieldOption[];
  sorts?: readonly TableSortRule[];
  visibleColumnIds: ReadonlySet<string>;
  visibleMetricKeys?: ReadonlySet<string>;
}) {
  const hasMetrics = metrics !== undefined && metrics.length > 0;
  const hasGrouping =
    grouping !== undefined &&
    groupOptions !== undefined &&
    onGroupingChange !== undefined;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2Icon />
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        collisionPadding={8}
        className="max-h-[min(var(--radix-dropdown-menu-content-available-height),75vh,40rem)] w-72 overflow-y-auto p-2"
      >
        <CompactSortControls
          maxSortRules={maxSortRules}
          onClear={onClearSort}
          onSort={onSort}
          onSortsChange={onSortsChange}
          options={sortOptions}
          sortBy={sortBy}
          sorts={sorts}
        />
        {hasGrouping ? (
          <>
            <DropdownMenuSeparator />
            <CompactGroupingControls
              grouping={grouping}
              onGroupingChange={onGroupingChange}
              options={groupOptions}
            />
          </>
        ) : null}
        {hasMetrics ? (
          <>
            <DropdownMenuSeparator />
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
          </>
        ) : null}
        <DropdownMenuSeparator />
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

function CompactSortControls({
  maxSortRules,
  onClear,
  onSort,
  onSortsChange,
  options,
  sortBy,
  sorts,
}: {
  maxSortRules?: number;
  onClear: () => void;
  onSort?: (fieldId: string) => void;
  onSortsChange?: (sorts: readonly TableSortRule[]) => void;
  options: readonly TableFieldOption[];
  sortBy: string | null;
  sorts?: readonly TableSortRule[];
}) {
  if (!onSortsChange) {
    return (
      <>
        <DropdownMenuLabel className="text-muted-foreground">
          Sort by
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            value === NO_SELECTION_VALUE ? onClear() : onSort?.(value)
          }
          value={sortBy ?? NO_SELECTION_VALUE}
        >
          <DropdownMenuRadioItem value={NO_SELECTION_VALUE}>
            None
          </DropdownMenuRadioItem>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </>
    );
  }

  const activeSorts = sorts ?? [];
  const atSortCap =
    maxSortRules !== undefined && activeSorts.length >= maxSortRules;
  const remaining = options.filter(
    (option) => !activeSorts.some((sort) => sort.fieldId === option.id)
  );
  const changeDirection = (fieldId: string, direction: "asc" | "desc") =>
    onSortsChange(setTableSortDirection(activeSorts, fieldId, direction));
  const remove = (fieldId: string) => {
    const next = removeTableSort(activeSorts, fieldId);
    if (next.length === 0) {
      onClear();
      return;
    }
    onSortsChange(next);
  };

  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground">
        Sorting
      </DropdownMenuLabel>
      {activeSorts.map((sort, index) => (
        <DropdownMenuSub key={sort.fieldId}>
          <DropdownMenuSubTrigger>
            <span className="w-5 text-muted-foreground tabular-nums">
              {index + 1}.
            </span>
            <span className="min-w-0 flex-1 truncate">
              {resolveFieldLabel(options, sort.fieldId, sort.fieldId)}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuItem
              onSelect={() => changeDirection(sort.fieldId, "asc")}
            >
              <ArrowUpIcon /> Ascending
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => changeDirection(sort.fieldId, "desc")}
            >
              <ArrowDownIcon /> Descending
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => remove(sort.fieldId)}>
              <XIcon /> Remove sort
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
      <DropdownMenuSub>
        {/* At the cap a pick REPLACES the rule rather than stacking one, so the
            trigger drops the additive word and its Plus glyph — the label is
            the only thing distinguishing the two outcomes. */}
        <DropdownMenuSubTrigger disabled={remaining.length === 0}>
          {atSortCap ? null : <PlusIcon />}
          {atSortCap ? "Sort by" : "Add sort"}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          {remaining.map((option) => (
            <DropdownMenuItem
              key={option.id}
              onSelect={() =>
                atSortCap
                  ? onSort?.(option.id)
                  : onSortsChange(appendTableSort(activeSorts, option.id))
              }
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

/**
 * Two nested radio submenus standing in for the wide layout's grouping editor.
 * Each submenu trigger reads its own current value under a caption, so the
 * applied grouping is legible without opening either.
 */
function CompactGroupingControls({
  grouping,
  onGroupingChange,
  options,
}: {
  grouping: TableGroupingState;
  onGroupingChange: (next: TableGroupingState) => void;
  options: readonly TableFieldOption[];
}) {
  const primaryLabel = resolveFieldLabel(
    options,
    grouping.primary.fieldId,
    "None"
  );
  const secondaryLabel = resolveFieldLabel(
    options,
    grouping.secondary.fieldId,
    "Add group"
  );
  const isGrouped = grouping.primary.fieldId !== null;

  return (
    <>
      <DropdownMenuLabel className="text-muted-foreground">
        Grouping
      </DropdownMenuLabel>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="min-h-10">
          <Layers2Icon />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-muted-foreground text-xs">Group by</span>
            <span className="truncate font-medium">{primaryLabel}</span>
          </span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-56">
          <DropdownMenuLabel className="text-muted-foreground">
            Group by
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(value) =>
              onGroupingChange(
                setPrimaryGroupingField(
                  grouping,
                  value === NO_SELECTION_VALUE ? null : value
                )
              )
            }
            value={grouping.primary.fieldId ?? NO_SELECTION_VALUE}
          >
            <DropdownMenuRadioItem value={NO_SELECTION_VALUE}>
              None
            </DropdownMenuRadioItem>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.id}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {isGrouped ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="min-h-10">
              <PlusIcon />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-muted-foreground text-xs">
                  Then group by
                </span>
                <span className="truncate font-medium">{secondaryLabel}</span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel className="text-muted-foreground">
                Then group by
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={(value) =>
                  onGroupingChange({
                    ...grouping,
                    secondary: {
                      ...grouping.secondary,
                      fieldId: value === NO_SELECTION_VALUE ? null : value,
                    },
                  })
                }
                value={grouping.secondary.fieldId ?? NO_SELECTION_VALUE}
              >
                <DropdownMenuRadioItem value={NO_SELECTION_VALUE}>
                  None
                </DropdownMenuRadioItem>
                {options
                  .filter((option) => option.id !== grouping.primary.fieldId)
                  .map((option) => (
                    <DropdownMenuRadioItem key={option.id} value={option.id}>
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      ) : (
        // Present but disabled rather than absent: a "Then group by" that only
        // appears once something else is set reads as the menu changing shape.
        <DropdownMenuItem disabled>
          <PlusIcon />
          Add second group
        </DropdownMenuItem>
      )}
    </>
  );
}
