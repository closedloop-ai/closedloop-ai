// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Preserve the reviewed prototype behavior in this isolated copy.
// biome-ignore-all lint/performance/noBarrelFile: This isolated prototype copy keeps its original public surface.
// biome-ignore-all lint/performance/useTopLevelRegex: Preserve the reviewed prototype implementation in this isolated copy.
"use client";

// Experimental variant scoped to Generic Artifact pending explicit promotion review.
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { cn } from "@repo/design-system/lib/utils";
import {
  CalendarIcon,
  CheckIcon,
  EyeOffIcon,
  ListFilterIcon,
  SearchIcon,
  StarIcon,
  TagIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import {
  isFilterMenuGroupActive,
  LeadingVisual,
  RangeFilterContent,
  RangeSubmenu,
} from "./filter-range-submenu";
import {
  type FilterMenuGroup,
  TABLE_DATE_PRESET_LABELS,
  TableDateFilterField,
  TableDatePreset,
  type TableFilterDatePresetOption,
  type TableFilterLabels,
  type TableFilterOption,
  type TableFiltersController,
  type TableFiltersViewModel,
} from "./table-filters";

export {
  type FilterMenuGroup,
  TableDateFilterField,
  TableDatePreset,
  type TableFilterCategory,
  type TableFiltersController,
  type TableFiltersViewModel,
} from "./table-filters";

type FilterPopoverProps<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  controller: TableFiltersController<TStatus, TPriority>;
  viewModel: TableFiltersViewModel<TStatus, TPriority>;
  /** Optional controlled open state, useful when a table header delegates into this menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Optional Asana-style clear action rendered beside the active trigger. */
  onClear?: () => void;
  /**
   * Optional free-text filter rendered as a search field at the top of the
   * menu. Filters the underlying table by text — independent of the facet
   * filters below it.
   */
  textFilter?: TableTextFilter;
};

export type TableTextFilter = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

const DEFAULT_LABELS: Required<TableFilterLabels> = {
  filterButton: "Filter",
  filterSearchPlaceholder: "Filter...",
  clearAll: "Clear all",
  clear: "Clear",
  loading: "Loading...",
  loadError: "Could not load members",
  noTags: "No tags created yet",
  addFilter: "Add filter",
  assignToMe: "Assigned to me",
  hideCompletedItems: "Hide completed items",
  favoritesOnly: "My Favorites",
  assignee: "Assignee",
  status: "Status",
  priority: "Priority",
  dates: "Dates",
  createdDate: "Date Created",
  updatedDate: "Updated Date",
  tags: "Tags",
  unassigned: "Unassigned",
};

const DEFAULT_DATE_PRESETS: TableFilterDatePresetOption[] = [
  TableDatePreset.Last24h,
  TableDatePreset.Last7d,
  TableDatePreset.Last30d,
  TableDatePreset.Last3m,
].map((value) => ({
  value,
  label: TABLE_DATE_PRESET_LABELS[value],
}));

export function FilterPopover<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  controller,
  viewModel,
  textFilter,
  open: controlledOpen,
  onOpenChange,
  onClear,
}: FilterPopoverProps<TStatus, TPriority>) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (nextOpen: boolean) => {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const labels = useLabels(viewModel.labels);
  // Count of applied filters: when generic facet groups drive the menu, count
  // the groups that are active (an options facet with a selection, or a range
  // facet with either bound set); otherwise one per active facet category
  // (activeChips mirrors isAnyFilterActive). Plus the in-menu text search when
  // it has input.
  const facetFilterCount = viewModel.facetGroups
    ? viewModel.facetGroups.filter(isFilterMenuGroupActive).length
    : controller.activeChips.length;
  const additionalFacetFilterCount =
    viewModel.additionalFacetGroups?.filter(isFilterMenuGroupActive).length ??
    0;
  const filterCount =
    facetFilterCount +
    additionalFacetFilterCount +
    ((textFilter?.value ?? "").length > 0 ? 1 : 0);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <div className="flex items-center">
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={labels.filterButton}
            className={cn(
              "h-8 shadow-none",
              filterCount > 0 &&
                "rounded-r-none border-primary/20 bg-primary/10 text-primary hover:bg-primary/15"
            )}
            size="sm"
            variant="outline"
          >
            <ListFilterIcon />
            {labels.filterButton}
            {filterCount > 0 ? `: ${filterCount}` : null}
          </Button>
        </DropdownMenuTrigger>
        {filterCount > 0 && onClear ? (
          <button
            aria-label="Clear filters"
            className="flex h-8 w-8 items-center justify-center rounded-r-md border border-primary/20 border-l-0 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            onClick={onClear}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
      <FilterMenuContent
        controller={controller}
        textFilter={textFilter}
        viewModel={viewModel}
      />
    </DropdownMenu>
  );
}

export function FilterMenuContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  controller,
  viewModel,
  textFilter,
}: FilterPopoverProps<TStatus, TPriority>) {
  const labels = useLabels(viewModel.labels);
  const {
    filters,
    toggleAssignToMe,
    toggleHideCompletedItems,
    toggleFavoritesOnly,
    toggleStatus,
    togglePriority,
    toggleTag,
  } = controller;

  const statusTotal = filters.statuses.length;
  const priorityTotal = filters.priorities.length;
  const datePresetOptions = viewModel.datePresets ?? DEFAULT_DATE_PRESETS;
  const tagOptions = viewModel.tagOptions ?? [];
  const showTags = viewModel.showTags ?? tagOptions.length > 0;

  if (viewModel.facetGroups) {
    return (
      <DropdownMenuContent align="start" className="w-52">
        {textFilter && (
          <FilterTextSearch
            onChange={textFilter.onChange}
            placeholder={
              textFilter.placeholder ?? labels.filterSearchPlaceholder
            }
            value={textFilter.value}
          />
        )}
        <DropdownMenuGroup>
          <FacetGroupItems
            clearLabel={labels.clear}
            groups={viewModel.facetGroups}
            searchPlaceholder={labels.filterSearchPlaceholder}
          />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    );
  }

  return (
    <DropdownMenuContent align="start" className="w-52">
      {textFilter && (
        <FilterTextSearch
          onChange={textFilter.onChange}
          placeholder={textFilter.placeholder ?? labels.filterSearchPlaceholder}
          value={textFilter.value}
        />
      )}
      {!viewModel.hideQuickToggles && (
        <>
          <DropdownMenuGroup>
            {!viewModel.hideAssignee && viewModel.currentUser && (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  toggleAssignToMe();
                }}
              >
                <Avatar className="size-[18px] shrink-0">
                  {viewModel.currentUser.avatarUrl && (
                    <AvatarImage alt="" src={viewModel.currentUser.avatarUrl} />
                  )}
                  <AvatarFallback className="text-[9px]">
                    {getInitials(viewModel.currentUser.name)}
                  </AvatarFallback>
                </Avatar>
                <span className={cn(filters.assignToMe && "font-medium")}>
                  {labels.assignToMe}
                </span>
                {filters.assignToMe && <CheckIcon className="ml-auto size-4" />}
              </DropdownMenuItem>
            )}
            {!viewModel.hideCompletedToggle && (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  toggleHideCompletedItems();
                }}
              >
                <LeadingVisual>
                  <EyeOffIcon className="size-3.5" />
                </LeadingVisual>
                <span
                  className={cn(filters.hideCompletedItems && "font-medium")}
                >
                  {labels.hideCompletedItems}
                </span>
                {filters.hideCompletedItems && (
                  <CheckIcon className="ml-auto size-4" />
                )}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                toggleFavoritesOnly();
              }}
            >
              <LeadingVisual>
                <StarIcon className="size-3.5" />
              </LeadingVisual>
              <span className={cn(filters.favoritesOnly && "font-medium")}>
                {labels.favoritesOnly}
              </span>
              {filters.favoritesOnly && (
                <CheckIcon className="ml-auto size-4" />
              )}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
        </>
      )}
      <DropdownMenuGroup>
        {!viewModel.hideAssignee && (
          <AssigneeSubmenu
            controller={controller}
            labels={labels}
            viewModel={viewModel}
          />
        )}
        <OptionsSubmenu
          count={statusTotal}
          icon={
            <LeadingVisual>
              <StatusIcon status="decorative" />
            </LeadingVisual>
          }
          label={labels.status}
          onToggle={toggleStatus}
          options={viewModel.statusOptions}
          searchPlaceholder={labels.filterSearchPlaceholder}
          selectedValues={filters.statuses}
          submenuClassName="w-60"
        />
        <OptionsSubmenu
          count={priorityTotal}
          icon={
            <LeadingVisual>
              {viewModel.priorityIcon ?? viewModel.priorityOptions[0]?.icon}
            </LeadingVisual>
          }
          label={labels.priority}
          onToggle={togglePriority}
          options={viewModel.priorityOptions}
          searchPlaceholder={labels.filterSearchPlaceholder}
          selectedValues={filters.priorities}
          submenuClassName="w-56"
        />
        <DatesSubmenu
          controller={controller}
          datePresetOptions={datePresetOptions}
          labels={labels}
        />
        {showTags && (
          <TagsSubmenu
            labels={labels}
            options={tagOptions}
            selectedTagIds={filters.tagIds}
            toggleTag={toggleTag}
          />
        )}
      </DropdownMenuGroup>
      {viewModel.additionalFacetGroups?.length ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <FacetGroupItems
              clearLabel={labels.clear}
              groups={viewModel.additionalFacetGroups}
              searchPlaceholder={labels.filterSearchPlaceholder}
            />
          </DropdownMenuGroup>
        </>
      ) : null}
    </DropdownMenuContent>
  );
}

function FacetGroupItems({
  clearLabel,
  groups,
  searchPlaceholder,
}: {
  clearLabel: string;
  groups: FilterMenuGroup[];
  searchPlaceholder: string;
}) {
  return groups.map((group) => {
    if (group.kind === "range") {
      return (
        <RangeSubmenu clearLabel={clearLabel} group={group} key={group.id} />
      );
    }
    return (
      <OptionsSubmenu
        count={group.selectedValues.length}
        emptyLabel={group.emptyLabel}
        icon={
          group.icon ? <LeadingVisual>{group.icon}</LeadingVisual> : undefined
        }
        key={group.id}
        label={group.label}
        onToggle={group.onToggle}
        options={group.options}
        searchPlaceholder={searchPlaceholder}
        selectedValues={group.selectedValues}
        submenuClassName={group.submenuClassName ?? "w-60"}
      />
    );
  });
}

export function AssigneeFilterContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({ controller, viewModel }: FilterPopoverProps<TStatus, TPriority>) {
  const labels = useLabels(viewModel.labels);
  const [search, setSearch] = useState("");
  const filteredMembers = viewModel.teamMembers.filter((member) =>
    (member.searchText ?? member.label)
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  return (
    <>
      <SubMenuSearch
        onChange={setSearch}
        placeholder={labels.filterSearchPlaceholder}
        value={search}
      />
      {viewModel.teamMembersLoading && (
        <div className="p-4 text-center text-muted-foreground text-sm">
          {labels.loading}
        </div>
      )}
      {viewModel.teamMembersError && (
        <div className="p-4 text-center text-muted-foreground text-sm">
          {labels.loadError}
        </div>
      )}
      {!(viewModel.teamMembersLoading || viewModel.teamMembersError) &&
        filteredMembers.map((member) => {
          const checked = controller.filters.assigneeIds.includes(member.id);
          return (
            <FilterRow
              checked={checked}
              key={member.id}
              onToggle={() => controller.toggleAssignee(member.id)}
            >
              <OptionLeadingVisual option={member} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  checked && "font-medium"
                )}
              >
                {member.label}
              </span>
              <OptionCount count={member.count} />
            </FilterRow>
          );
        })}
    </>
  );
}

export function StatusFilterContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({ controller, viewModel }: FilterPopoverProps<TStatus, TPriority>) {
  return (
    <OptionsFilterContent
      onToggle={controller.toggleStatus}
      options={viewModel.statusOptions}
      searchPlaceholder={useLabels(viewModel.labels).filterSearchPlaceholder}
      selectedValues={controller.filters.statuses}
    />
  );
}

export function PriorityFilterContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({ controller, viewModel }: FilterPopoverProps<TStatus, TPriority>) {
  return (
    <OptionsFilterContent
      onToggle={controller.togglePriority}
      options={viewModel.priorityOptions}
      searchPlaceholder={useLabels(viewModel.labels).filterSearchPlaceholder}
      selectedValues={controller.filters.priorities}
    />
  );
}

export function DateFilterContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  controller,
  field = TableDateFilterField.CreatedAt,
  datePresetOptions,
}: {
  controller: TableFiltersController<TStatus, TPriority>;
  field?: TableDateFilterField;
  datePresetOptions?: TableFilterDatePresetOption[];
}) {
  const currentPreset =
    controller.filters.date?.field === field
      ? controller.filters.date.preset
      : null;
  const presets = datePresetOptions ?? DEFAULT_DATE_PRESETS;

  return (
    <>
      {presets.map((preset) => {
        const selected = currentPreset === preset.value;
        return (
          <DropdownMenuItem
            key={preset.value}
            onSelect={() => {
              if (currentPreset === preset.value) {
                controller.setDateFilter(null);
                return;
              }
              controller.setDateFilter({
                field,
                preset: preset.value,
              });
            }}
          >
            <span className={cn("flex-1", selected && "font-medium")}>
              {preset.label}
            </span>
            {selected && <CheckIcon className="ml-auto size-4" />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

export function TagsFilterContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({ controller, viewModel }: FilterPopoverProps<TStatus, TPriority>) {
  const labels = useLabels(viewModel.labels);
  const tagOptions = viewModel.tagOptions ?? [];

  if (tagOptions.length === 0) {
    return <DropdownMenuItem disabled>{labels.noTags}</DropdownMenuItem>;
  }

  return (
    <>
      {tagOptions.map((tag) => (
        <FilterRow
          checked={controller.filters.tagIds.includes(tag.id)}
          key={tag.id}
          onToggle={() => controller.toggleTag(tag.id)}
        >
          <TagVisual option={tag} />
          <span className="min-w-0 flex-1 truncate">{tag.label}</span>
          <OptionCount count={tag.count} />
        </FilterRow>
      ))}
    </>
  );
}

function OptionsSubmenu<TValue extends string>({
  count,
  emptyLabel,
  icon,
  label,
  options,
  searchPlaceholder,
  selectedValues,
  submenuClassName,
  onToggle,
}: {
  count: number;
  emptyLabel?: string;
  icon?: ReactNode;
  label: string;
  options: TableFilterOption<TValue>[];
  searchPlaceholder: string;
  selectedValues: TValue[];
  submenuClassName: string;
  onToggle: (value: TValue) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {icon}
        <span className="flex-1">{label}</span>
        {count > 0 && (
          <span className="text-muted-foreground text-xs">{count}</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className={submenuClassName}>
          <OptionsFilterContent
            emptyLabel={emptyLabel}
            onToggle={onToggle}
            options={options}
            searchPlaceholder={searchPlaceholder}
            selectedValues={selectedValues}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

export function OptionsFilterContent<TValue extends string>({
  emptyLabel,
  options,
  searchPlaceholder,
  selectedValues,
  onToggle,
}: {
  emptyLabel?: string;
  options: TableFilterOption<TValue>[];
  searchPlaceholder: string;
  selectedValues: TValue[];
  onToggle: (value: TValue) => void;
}) {
  const [search, setSearch] = useState("");

  // A facet with zero options renders a disabled explanatory row instead of a
  // bare search box, mirroring the built-in tags submenu — "nothing to filter
  // by", not broken/loading. Only when the host supplied a message; otherwise
  // keep the prior (empty) behavior for callers that never pass one.
  if (options.length === 0 && emptyLabel) {
    return <DropdownMenuItem disabled>{emptyLabel}</DropdownMenuItem>;
  }

  const filteredOptions = options.filter((option) =>
    (option.searchText ?? option.label)
      .toLowerCase()
      .includes(search.toLowerCase())
  );

  return (
    <>
      <SubMenuSearch
        onChange={setSearch}
        placeholder={searchPlaceholder}
        value={search}
      />
      {filteredOptions.map((option, index) => {
        const checked = selectedValues.includes(option.id);
        const previousOption = filteredOptions[index - 1];
        const showSectionLabel =
          option.sectionLabel &&
          option.sectionLabel !== previousOption?.sectionLabel;
        return (
          <Fragment key={option.id}>
            {showSectionLabel && (
              <DropdownMenuLabel className="px-2 pt-2 pb-1 text-muted-foreground text-xs">
                {option.sectionLabel}
              </DropdownMenuLabel>
            )}
            <FilterRow checked={checked} onToggle={() => onToggle(option.id)}>
              <OptionLeadingVisual option={option} />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  checked && "font-medium"
                )}
              >
                {option.label}
              </span>
              <OptionCount count={option.count} />
            </FilterRow>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * Direct controls for one host-defined facet. Used by column header menus,
 * where the surrounding Filter submenu is already provided by the grid.
 */
export function FilterGroupContent({
  clearLabel = "Clear",
  group,
  searchPlaceholder = "Filter...",
}: {
  clearLabel?: string;
  group: FilterMenuGroup;
  searchPlaceholder?: string;
}) {
  if (group.kind === "range") {
    return <RangeFilterContent clearLabel={clearLabel} group={group} />;
  }
  return (
    <OptionsFilterContent
      emptyLabel={group.emptyLabel}
      onToggle={group.onToggle}
      options={group.options}
      searchPlaceholder={searchPlaceholder}
      selectedValues={group.selectedValues}
    />
  );
}

function AssigneeSubmenu<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  controller,
  viewModel,
  labels,
}: FilterPopoverProps<TStatus, TPriority> & {
  labels: Required<TableFilterLabels>;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <LeadingVisual>
          <UsersIcon className="size-3.5" />
        </LeadingVisual>
        <span className="flex-1">{labels.assignee}</span>
        {controller.filters.assigneeIds.length > 0 && (
          <span className="text-muted-foreground text-xs">
            {controller.filters.assigneeIds.length}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-64">
          <AssigneeFilterContent
            controller={controller}
            viewModel={viewModel}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function DatesSubmenu<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  controller,
  datePresetOptions,
  labels,
}: {
  controller: TableFiltersController<TStatus, TPriority>;
  datePresetOptions: TableFilterDatePresetOption[];
  labels: Required<TableFilterLabels>;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <LeadingVisual>
          <CalendarIcon className="size-3.5" />
        </LeadingVisual>
        <span className="flex-1">{labels.dates}</span>
        {controller.filters.date && (
          <span className="text-muted-foreground text-xs">1</span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-48">
          <DateFieldSubmenu
            controller={controller}
            datePresetOptions={datePresetOptions}
            field={TableDateFilterField.CreatedAt}
            label={labels.createdDate}
          />
          <DateFieldSubmenu
            controller={controller}
            datePresetOptions={datePresetOptions}
            field={TableDateFilterField.UpdatedAt}
            label={labels.updatedDate}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function DateFieldSubmenu<
  TStatus extends string = string,
  TPriority extends string = string,
>({
  controller,
  datePresetOptions,
  field,
  label,
}: {
  controller: TableFiltersController<TStatus, TPriority>;
  datePresetOptions: TableFilterDatePresetOption[];
  field: TableDateFilterField;
  label: string;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <CalendarIcon className="size-4" />
        <span className="flex-1">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-44">
          <DateFilterContent
            controller={controller}
            datePresetOptions={datePresetOptions}
            field={field}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function TagsSubmenu({
  labels,
  options,
  selectedTagIds,
  toggleTag,
}: {
  labels: Required<TableFilterLabels>;
  options: TableFilterOption[];
  selectedTagIds: string[];
  toggleTag: (tagId: string) => void;
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <LeadingVisual>
          <TagIcon className="size-3.5" />
        </LeadingVisual>
        <span className="flex-1">{labels.tags}</span>
        {selectedTagIds.length > 0 && (
          <span className="text-muted-foreground text-xs">
            {selectedTagIds.length}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56">
          {options.length === 0 ? (
            <DropdownMenuItem disabled>{labels.noTags}</DropdownMenuItem>
          ) : (
            options.map((tag) => (
              <FilterRow
                checked={selectedTagIds.includes(tag.id)}
                key={tag.id}
                onToggle={() => toggleTag(tag.id)}
              >
                <TagVisual option={tag} />
                <span className="min-w-0 flex-1 truncate">{tag.label}</span>
                <OptionCount count={tag.count} />
              </FilterRow>
            ))
          )}
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/**
 * Fixed-width box for a menu item's leading icon. Keeps every leading visual the
 * same footprint (so the text labels stay aligned) while letting the avatar fill
 * the box and the icons sit padded/centered inside it.
 */
function FilterTextSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          aria-label={placeholder || "Search"}
          className="h-5 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder={placeholder}
          type="text"
          value={value}
        />
        {value && (
          <button
            aria-label="Clear search"
            className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            onClick={() => onChange("")}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        )}
      </div>
      <DropdownMenuSeparator />
    </>
  );
}

function SubMenuSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <>
      <div className="px-2 pt-0.5 pb-1.5">
        <input
          aria-label={placeholder || "Search"}
          className="h-6 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          placeholder={placeholder}
          type="text"
          value={value}
        />
      </div>
      <DropdownMenuSeparator className="mt-0 mb-1" />
    </>
  );
}

function FilterRow({
  checked,
  onToggle,
  children,
}: {
  checked: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuItem
      className="gap-2"
      onSelect={(event) => {
        event.preventDefault();
        onToggle();
      }}
    >
      <Checkbox
        checked={checked}
        className="[&_svg]:!text-current pointer-events-none"
      />
      {children}
    </DropdownMenuItem>
  );
}

function OptionLeadingVisual({ option }: { option: TableFilterOption }) {
  if (option.avatarUrl) {
    return (
      <Avatar className="size-5">
        <AvatarImage alt="" src={option.avatarUrl} />
        <AvatarFallback className="text-[10px]">
          {getInitials(option.label)}
        </AvatarFallback>
      </Avatar>
    );
  }

  if (option.icon) {
    return (
      <div className="flex size-5 items-center justify-center">
        {option.icon}
      </div>
    );
  }

  return null;
}

function TagVisual({ option }: { option: TableFilterOption }) {
  return (
    <div className="inline-flex min-w-0 items-center gap-2">
      <span
        aria-hidden="true"
        className="size-2.5 shrink-0 rounded-full border"
        style={{ backgroundColor: option.color, borderColor: option.color }}
      />
    </div>
  );
}

function OptionCount({ count }: { count?: number }) {
  if (count === undefined) {
    return null;
  }

  return <span className="text-muted-foreground text-xs">{count}</span>;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function useLabels(labels?: TableFilterLabels): Required<TableFilterLabels> {
  return useMemo(
    () => ({
      ...DEFAULT_LABELS,
      ...labels,
    }),
    [labels]
  );
}
