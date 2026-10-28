"use client";

// Grid Table Toolbar v2 promotion candidate, derived from the approved Generic
// Artifact prototype's list controls.

import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@closedloop-ai/design-system/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@closedloop-ai/design-system/components/ui/select";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  GripVerticalIcon,
  GroupIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import {
  countActiveGroupingLevels,
  EMPTY_TABLE_GROUPING,
  removePrimaryGroupingLevel,
  setPrimaryGroupingField,
  swapGroupingLevels,
  type TableFieldOption,
  TableGroupOrder,
  type TableGroupingLevel,
  type TableGroupingState,
} from "./table-toolbar-model";

/** Drag payload identifying which grouping level is being reordered. */
const GROUP_LEVEL_DRAG_DATA_TYPE = "text/table-group-level";

const GroupingLevelName = {
  Primary: "primary",
  Secondary: "secondary",
} as const;
type GroupingLevelName =
  (typeof GroupingLevelName)[keyof typeof GroupingLevelName];

/**
 * The toolbar's Group control: a button reporting how many levels are grouping,
 * and a popover holding the two-level grouping editor.
 *
 * Grouping is edited in a POPOVER rather than a dropdown because each level is
 * a row of three controls (field, order, options) plus a drag handle — a
 * dropdown menu's one-item-per-row model cannot hold that, and the prototype
 * proved the editor shape before this was promoted.
 *
 * The whole state moves through one `grouping` object and one `onGroupingChange`
 * callback rather than eight separate setters, because the transitions are
 * COUPLED: removing the primary level promotes the secondary into its place,
 * choosing a field the other level already uses drops that other level, and
 * dragging one level onto the other swaps both. Those rules live in
 * `table-toolbar-model.ts` as pure functions, so they are the same rules
 * wherever a surface reproduces them and they are testable without a popover.
 */
export function TableGroupMenu({
  align = "end",
  allowEmptyGroups = true,
  grouping,
  onGroupingChange,
  options,
}: {
  align?: "start" | "center" | "end";
  /**
   * Whether the per-level "Show empty groups" action is offered.
   *
   * A band this menu cannot render is one the CALLER has to materialize, and a
   * caller whose grouping dimensions are derived from the rows themselves has
   * no band outside them to show. Opting out is how such a surface avoids
   * offering a control that reports a state change it cannot produce. Defaults
   * to `true` so a surface that does honour the flag keeps the action.
   */
  allowEmptyGroups?: boolean;
  grouping: TableGroupingState;
  onGroupingChange: (next: TableGroupingState) => void;
  /** The fields this table can group by, already merged by the caller. */
  options: readonly TableFieldOption[];
}) {
  const activeLevels = countActiveGroupingLevels(grouping);
  const isGrouped = grouping.primary.fieldId !== null;
  const clearAll = () => onGroupingChange(EMPTY_TABLE_GROUPING);
  const updateLevel = (
    level: GroupingLevelName,
    changes: Partial<TableGroupingLevel>
  ) =>
    onGroupingChange({
      ...grouping,
      [level]: { ...grouping[level], ...changes },
    });

  return (
    <Popover>
      <div className="flex items-center">
        <PopoverTrigger asChild>
          <Button
            className={cn(
              isGrouped &&
                "rounded-r-none border-primary/20 bg-primary/10 text-primary hover:bg-primary/15"
            )}
            size="sm"
            variant="outline"
          >
            <GroupIcon />
            {activeLevels === 0 ? "Group" : `Groups: ${activeLevels}`}
          </Button>
        </PopoverTrigger>
        {isGrouped ? (
          <button
            aria-label="Clear groups"
            className="flex h-8 w-8 items-center justify-center rounded-r-md border border-primary/20 border-l-0 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            onClick={clearAll}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
      <PopoverContent
        align={align}
        className="w-[min(38rem,calc(100vw-2rem))] space-y-4 p-5"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-base">Groups</h3>
          {activeLevels > 0 ? (
            <Button onClick={clearAll} size="sm" variant="ghost">
              Clear
            </Button>
          ) : null}
        </div>
        {isGrouped ? (
          <div className="space-y-3">
            <GroupingEditorRow
              allowEmptyGroups={allowEmptyGroups}
              excludedFieldId={grouping.secondary.fieldId}
              level={GroupingLevelName.Primary}
              onFieldChange={(fieldId) =>
                onGroupingChange(setPrimaryGroupingField(grouping, fieldId))
              }
              onOrderChange={(order) =>
                updateLevel(GroupingLevelName.Primary, { order })
              }
              onRemove={() =>
                onGroupingChange(removePrimaryGroupingLevel(grouping))
              }
              onShowEmptyGroupsChange={(showEmptyGroups) =>
                updateLevel(GroupingLevelName.Primary, { showEmptyGroups })
              }
              onSwap={() => onGroupingChange(swapGroupingLevels(grouping))}
              options={options}
              value={grouping.primary}
            />
            {grouping.secondary.fieldId === null ? (
              <GroupFieldPicker
                label="Add subgroup"
                onSelect={(fieldId) =>
                  updateLevel(GroupingLevelName.Secondary, { fieldId })
                }
                options={options.filter(
                  (option) => option.id !== grouping.primary.fieldId
                )}
              />
            ) : (
              <GroupingEditorRow
                allowEmptyGroups={allowEmptyGroups}
                excludedFieldId={grouping.primary.fieldId}
                level={GroupingLevelName.Secondary}
                onFieldChange={(fieldId) =>
                  updateLevel(GroupingLevelName.Secondary, { fieldId })
                }
                onOrderChange={(order) =>
                  updateLevel(GroupingLevelName.Secondary, { order })
                }
                onRemove={() =>
                  updateLevel(GroupingLevelName.Secondary, { fieldId: null })
                }
                onShowEmptyGroupsChange={(showEmptyGroups) =>
                  updateLevel(GroupingLevelName.Secondary, { showEmptyGroups })
                }
                onSwap={() => onGroupingChange(swapGroupingLevels(grouping))}
                options={options}
                value={grouping.secondary}
              />
            )}
          </div>
        ) : (
          <EmptyGroupingEditorRow
            onSelect={(fieldId) =>
              onGroupingChange(setPrimaryGroupingField(grouping, fieldId))
            }
            options={options}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The resting state: the same five-column grid as a real level so the editor
 * does not jump when the first group is chosen, with everything but the field
 * picker disabled. A placeholder row rather than a bare "Add group" button
 * because it TEACHES the shape — the reader can see that a group has an order
 * and can be removed before committing to one.
 */
function EmptyGroupingEditorRow({
  onSelect,
  options,
}: {
  onSelect: (fieldId: string) => void;
  options: readonly TableFieldOption[];
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2">
      <GripVerticalIcon className="size-4 text-muted-foreground/50" />
      <Select onValueChange={onSelect}>
        <SelectTrigger aria-label="Primary grouping field" className="w-full">
          <SelectValue placeholder="Select group" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select disabled value={TableGroupOrder.Ascending}>
        <SelectTrigger aria-label="Primary group order" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={TableGroupOrder.Ascending}>Ascending</SelectItem>
        </SelectContent>
      </Select>
      <Button
        aria-label="Primary group options"
        disabled
        size="icon-sm"
        variant="ghost"
      >
        <EllipsisIcon />
      </Button>
      <Button
        aria-label="Remove primary group"
        disabled
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
}

function GroupFieldPicker({
  label,
  onSelect,
  options,
}: {
  label: string;
  onSelect: (fieldId: string) => void;
  options: readonly TableFieldOption[];
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="justify-start" size="sm" variant="ghost">
          <PlusIcon /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            onSelect={() => onSelect(option.id)}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One grouping level. Draggable onto the other level to swap the two, which is
 * how a pointer user reorders "group by Status, then Owner" into "group by
 * Owner, then Status" — the keyboard path is to change each level's field
 * directly, since both selects are reachable.
 *
 * The level's own field is never excluded from its select (only the OTHER
 * level's is), so the current value can always render.
 */
function GroupingEditorRow({
  allowEmptyGroups,
  excludedFieldId,
  level,
  onFieldChange,
  onOrderChange,
  onRemove,
  onShowEmptyGroupsChange,
  onSwap,
  options,
  value,
}: {
  allowEmptyGroups: boolean;
  excludedFieldId: string | null;
  level: GroupingLevelName;
  onFieldChange: (fieldId: string) => void;
  onOrderChange: (order: TableGroupOrder) => void;
  onRemove: () => void;
  onShowEmptyGroupsChange: (showEmptyGroups: boolean) => void;
  onSwap: () => void;
  options: readonly TableFieldOption[];
  value: TableGroupingLevel;
}) {
  const levelLabel = groupingLevelLabel[level];
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: The level is a drag reorder target containing its own accessible controls; the keyboard path is the field selects.
    // biome-ignore lint/a11y/noStaticElementInteractions: The level is a drag reorder target containing its own accessible controls; the keyboard path is the field selects.
    <div
      className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2"
      draggable
      onDragOver={(event) => event.preventDefault()}
      onDragStart={(event) => {
        event.dataTransfer.setData(GROUP_LEVEL_DRAG_DATA_TYPE, level);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (event.dataTransfer.getData(GROUP_LEVEL_DRAG_DATA_TYPE) !== level) {
          onSwap();
        }
      }}
    >
      <GripVerticalIcon className="size-4 cursor-grab text-muted-foreground" />
      <Select onValueChange={onFieldChange} value={value.fieldId ?? undefined}>
        <SelectTrigger
          aria-label={`${levelLabel} grouping field`}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options
            .filter((option) => option.id !== excludedFieldId)
            .map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Select
        onValueChange={(next) => onOrderChange(next as TableGroupOrder)}
        value={value.order}
      >
        <SelectTrigger
          aria-label={`${levelLabel} group order`}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={TableGroupOrder.Custom}>Custom order</SelectItem>
          <SelectItem value={TableGroupOrder.Ascending}>
            <span className="flex items-center gap-2">
              <ArrowUpIcon className="size-4" />
              Ascending
            </span>
          </SelectItem>
          <SelectItem value={TableGroupOrder.Descending}>
            <span className="flex items-center gap-2">
              <ArrowDownIcon className="size-4" />
              Descending
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      {allowEmptyGroups ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={`${levelLabel} group options`}
              size="icon-sm"
              variant="ghost"
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem
              onSelect={() => onShowEmptyGroupsChange(!value.showEmptyGroups)}
            >
              {value.showEmptyGroups ? <EyeOffIcon /> : <EyeIcon />}
              {value.showEmptyGroups ? "Hide empty groups" : "Show empty groups"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        // The grid track stays, so removing the action does not reflow the
        // level's field/order controls out from under a reader who has both
        // widths open.
        <span aria-hidden />
      )}
      <Button
        aria-label={`Remove ${levelLabel.toLowerCase()} group`}
        onClick={onRemove}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
}

const groupingLevelLabel = {
  [GroupingLevelName.Primary]: "Primary",
  [GroupingLevelName.Secondary]: "Secondary",
} as const;
