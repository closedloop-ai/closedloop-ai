"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  TableViewMenu,
  type TableViewMenuColumn,
} from "@repo/design-system/components/ui/table-view-menu";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@repo/design-system/components/ui/toggle-group";
import { ListFilterIcon } from "lucide-react";
import {
  DATE_RANGE_LABELS,
  DATE_RANGE_SHORT_LABELS,
  DATE_RANGES,
  type DateRange,
} from "../mock";

// Slugs a component name into a stable id so each facet checkbox and its label
// can be associated via id / htmlFor.
const WHITESPACE = /\s+/g;
const facetFieldId = (option: string) =>
  `component-filter-${option.toLowerCase().replace(WHITESPACE, "-")}`;

// The Sessions toolbar, mirroring the production left-aligned cluster
// (packages/app/agents/components/sessions/sessions-toolbar.tsx): an
// always-visible date-range segmented control, a "Filter" popover, and a "View"
// column menu. Each control drives the table below it.
type SessionsToolbarProps = {
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  componentOptions: readonly string[];
  selectedComponents: ReadonlySet<string>;
  onToggleComponent: (component: string) => void;
  onClearComponents: () => void;
  columns: TableViewMenuColumn[];
  onToggleColumn: (columnId: string) => void;
  onResetView: () => void;
};

export const SessionsToolbar = ({
  dateRange,
  onDateRangeChange,
  componentOptions,
  selectedComponents,
  onToggleComponent,
  onClearComponents,
  columns,
  onToggleColumn,
  onResetView,
}: SessionsToolbarProps) => (
  <div className="flex flex-wrap items-center gap-2">
    <DateRangeControl onChange={onDateRangeChange} value={dateRange} />
    <ComponentFilter
      onClear={onClearComponents}
      onToggle={onToggleComponent}
      options={componentOptions}
      selected={selectedComponents}
    />
    <TableViewMenu
      align="start"
      columns={columns}
      onResetView={onResetView}
      onToggleColumn={onToggleColumn}
    />
  </div>
);

// Replicates the shared DateRangeFilter (a compact outline segmented control).
// The 26px item height lands the whole control at the 32px of the sibling
// Filter / View buttons, matching the production toolbar.
const DateRangeControl = ({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) => (
  <ToggleGroup
    aria-label="Date range"
    onValueChange={(next) => {
      if (next) {
        onChange(next as DateRange);
      }
    }}
    type="single"
    value={value}
    variant="outline"
  >
    {DATE_RANGES.map((range) => (
      <ToggleGroupItem
        aria-label={DATE_RANGE_LABELS[range]}
        className="px-2.5 data-[variant=outline]:h-[26px]"
        key={range}
        value={range}
      >
        {DATE_RANGE_SHORT_LABELS[range]}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);

const ComponentFilter = ({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: readonly string[];
  selected: ReadonlySet<string>;
  onToggle: (component: string) => void;
  onClear: () => void;
}) => (
  <Popover>
    <PopoverTrigger asChild>
      <Button size="sm" variant="outline">
        <ListFilterIcon />
        Filter
        {selected.size > 0 ? (
          <Badge className="ml-1" variant="secondary">
            {selected.size}
          </Badge>
        ) : null}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-56 p-2">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="font-medium text-muted-foreground text-xs">
          Component
        </span>
        {selected.size > 0 ? (
          <Button
            className="h-auto p-0 text-xs"
            onClick={onClear}
            variant="link"
          >
            Clear
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5">
        {options.map((option) => (
          <label
            className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-muted/50"
            htmlFor={facetFieldId(option)}
            key={option}
          >
            <Checkbox
              checked={selected.has(option)}
              id={facetFieldId(option)}
              onCheckedChange={() => onToggle(option)}
            />
            {option}
          </label>
        ))}
      </div>
    </PopoverContent>
  </Popover>
);
