"use client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@closedloop-ai/design-system/components/ui/avatar";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Checkbox } from "@closedloop-ai/design-system/components/ui/checkbox";
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
} from "@closedloop-ai/design-system/components/ui/dropdown-menu";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import {
  CalendarIcon,
  CheckIcon,
  EyeOffIcon,
  ListFilterIcon,
  SearchIcon,
  StarIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { StatusIcon } from "./status-icon";
import {
  TABLE_DATE_PRESET_LABELS,
  TableDateFilterField,
  TableDatePreset,
  type FilterFacetGroup,
  type TableFilterLabels,
  type TableFilterDatePresetOption,
  type TableFilterOption,
  type TableFiltersController,
  type TableFiltersViewModel,
} from "./table-filters";

type FilterPopoverProps<
  TStatus extends string = string,
  TPriority extends string = string,
> = {
  controller: TableFiltersController<TStatus, TPriority>;
  viewModel: TableFiltersViewModel<TStatus, TPriority>;
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
>({ controller, viewModel, textFilter }: FilterPopoverProps<TStatus, TPriority>) {
  const [open, setOpen] = useState(false);
  const labels = useLabels(viewModel.labels);
  // Count of applied filters: when generic facet groups drive the menu, count
  // the groups with at least one selection; otherwise one per active facet
  // category (activeChips mirrors isAnyFilterActive). Plus the in-menu text
  // search when it has input.
  const facetFilterCount = viewModel.facetGroups
    ? viewModel.facetGroups.filter((group) => group.selectedValues.length > 0)
        .length
    : controller.activeChips.length;
  const filterCount =
    facetFilterCount + ((textFilter?.value ?? "").length > 0 ? 1 : 0);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={labels.filterButton}
          className="h-8 shadow-none"
          size="sm"
          variant="outline"
        >
          <ListFilterIcon />
          {labels.filterButton}
          {filterCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-medium text-[10px] text-primary-foreground tabular-nums">
              {filterCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
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
>({ controller, viewModel, textFilter }: FilterPopoverProps<TStatus, TPriority>) {
  const labels = useLabels(viewModel.labels);
  const {
    filters,
    toggleAssignee,
    toggleAssignToMe,
    toggleHideCompletedItems,
    toggleFavoritesOnly,
    toggleStatus,
    togglePriority,
    setDateFilter,
    toggleTag,
  } = controller;

  const assigneeTotal = filters.assigneeIds.length;
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
          {viewModel.facetGroups.map((group) => (
            <OptionsSubmenu
              count={group.selectedValues.length}
              icon={group.icon ? <LeadingVisual>{group.icon}</LeadingVisual> : undefined}
              key={group.id}
              label={group.label}
              onToggle={group.onToggle}
              options={group.options}
              searchPlaceholder={labels.filterSearchPlaceholder}
              selectedValues={group.selectedValues}
              submenuClassName={group.submenuClassName ?? "w-60"}
            />
          ))}
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
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            toggleHideCompletedItems();
          }}
        >
          <LeadingVisual>
            <EyeOffIcon className="size-3.5" />
          </LeadingVisual>
          <span className={cn(filters.hideCompletedItems && "font-medium")}>
            {labels.hideCompletedItems}
          </span>
          {filters.hideCompletedItems && (
            <CheckIcon className="ml-auto size-4" />
          )}
        </DropdownMenuItem>
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
          {filters.favoritesOnly && <CheckIcon className="ml-auto size-4" />}
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
          icon={<LeadingVisual><StatusIcon status="decorative" /></LeadingVisual>}
          label={labels.status}
          options={viewModel.statusOptions}
          searchPlaceholder={labels.filterSearchPlaceholder}
          selectedValues={filters.statuses}
          submenuClassName="w-60"
          onToggle={toggleStatus}
        />
        <OptionsSubmenu
          count={priorityTotal}
          icon={<LeadingVisual>{viewModel.priorityOptions[0]?.icon}</LeadingVisual>}
          label={labels.priority}
          options={viewModel.priorityOptions}
          searchPlaceholder={labels.filterSearchPlaceholder}
          selectedValues={filters.priorities}
          submenuClassName="w-56"
          onToggle={togglePriority}
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
    </DropdownMenuContent>
  );
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
      options={viewModel.statusOptions}
      searchPlaceholder={useLabels(viewModel.labels).filterSearchPlaceholder}
      selectedValues={controller.filters.statuses}
      onToggle={controller.toggleStatus}
    />
  );
}

export function PriorityFilterContent<
  TStatus extends string = string,
  TPriority extends string = string,
>({ controller, viewModel }: FilterPopoverProps<TStatus, TPriority>) {
  return (
    <OptionsFilterContent
      options={viewModel.priorityOptions}
      searchPlaceholder={useLabels(viewModel.labels).filterSearchPlaceholder}
      selectedValues={controller.filters.priorities}
      onToggle={controller.togglePriority}
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
    controller.filters.date?.field === field ? controller.filters.date.preset : null;
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
  icon,
  label,
  options,
  searchPlaceholder,
  selectedValues,
  submenuClassName,
  onToggle,
}: {
  count: number;
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
            options={options}
            searchPlaceholder={searchPlaceholder}
            selectedValues={selectedValues}
            onToggle={onToggle}
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

function OptionsFilterContent<TValue extends string>({
  options,
  searchPlaceholder,
  selectedValues,
  onToggle,
}: {
  options: TableFilterOption<TValue>[];
  searchPlaceholder: string;
  selectedValues: TValue[];
  onToggle: (value: TValue) => void;
}) {
  const [search, setSearch] = useState("");
  const filteredOptions = options.filter((option) =>
    (option.searchText ?? option.label).toLowerCase().includes(search.toLowerCase())
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
            <FilterRow
              checked={checked}
              onToggle={() => onToggle(option.id)}
            >
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
          <AssigneeFilterContent controller={controller} viewModel={viewModel} />
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
function LeadingVisual({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-[18px] shrink-0 items-center justify-center">
      {children}
    </span>
  );
}

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
    return <div className="flex size-5 items-center justify-center">{option.icon}</div>;
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
