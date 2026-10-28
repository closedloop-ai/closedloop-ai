"use client";

import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import {
  type TableToolbarCustomFieldCapabilities,
  TableToolbarGroupMenu,
  type TableToolbarGroupOrder,
  TableToolbarOptionsMenu,
  type TableToolbarSavedView,
  TableToolbarSavedViewsMenu,
  TableToolbarSortMenu,
  TableToolbarViewMenu,
} from "@repo/app/shared/components/table-toolbar-controls";
import {
  type ArtifactStatusFacet,
  ArtifactStatusVariant,
} from "@repo/app/shared/lib/artifact-status-view-contract";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  TABLE_BULK_ACTION_BUTTON_CLASS_NAME,
  TableBulkActionBar,
  TableBulkActionButton,
} from "@repo/design-system/components/ui/table-bulk-action-bar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { ColumnDefinition } from "@repo/design-system/lib/column-registry";
import {
  CircleDotDashedIcon,
  FolderInputIcon,
  FolderPlusIcon,
  PlusIcon,
  StarIcon,
  TagIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import type * as React from "react";
import { type ReactNode, useState } from "react";
import type { GenericArtifact } from "../fixtures";
import {
  type ArtifactBulkAction,
  type ArtifactListSummaryMetric,
  isCustomFieldGroupable,
  isCustomFieldSortable,
  type TagDefinition,
} from "./artifact-list-model";
import { EDITABLE_OWNERS } from "./artifact-list-owners";

export type ArtifactSavedView = TableToolbarSavedView;

/**
 * ISS-10476 promoted these five menus into
 * `@repo/app/shared/components/table-toolbar-controls` so the portable Projects
 * surface drives the same toolbar. What stays here is this prototype's own
 * vocabulary: which custom-field TYPES it lets a reader sort and group by.
 */
export const ARTIFACT_CUSTOM_FIELD_CAPABILITIES: TableToolbarCustomFieldCapabilities =
  {
    groupable: isCustomFieldGroupable,
    sortable: isCustomFieldSortable,
  };

export function ArtifactSavedViewsMenu(props: {
  activeViewId: string;
  onApply: (viewId: string) => void;
  onSave: (name: string) => void;
  views: readonly ArtifactSavedView[];
}) {
  return <TableToolbarSavedViewsMenu {...props} />;
}

export function ArtifactSortMenu(props: {
  active: boolean;
  columns: readonly ColumnDefinition[];
  customFields: CustomFieldDefinition[];
  /** Visible name of the host's leading column. Defaults to "Artifact". */
  leadingLabel?: string;
  onClear: () => void;
  onSort: (column: string, direction: SortDirection) => void;
  sortBy: string;
}) {
  return (
    <TableToolbarSortMenu
      {...props}
      customFieldCapabilities={ARTIFACT_CUSTOM_FIELD_CAPABILITIES}
    />
  );
}

export function ArtifactGroupMenu(props: {
  columns: readonly ColumnDefinition[];
  customFields: CustomFieldDefinition[];
  groupBy: string;
  secondaryGroupBy: string;
  setGroupBy: (groupBy: string) => void;
  setSecondaryGroupBy: (groupBy: string) => void;
  groupOrder: TableToolbarGroupOrder;
  secondaryGroupOrder: TableToolbarGroupOrder;
  setGroupOrder: (order: TableToolbarGroupOrder) => void;
  setSecondaryGroupOrder: (order: TableToolbarGroupOrder) => void;
  showEmptyGroups: boolean;
  setShowEmptyGroups: (show: boolean) => void;
  showEmptySubgroups: boolean;
  setShowEmptySubgroups: (show: boolean) => void;
}) {
  return (
    <TableToolbarGroupMenu
      {...props}
      customFieldCapabilities={ARTIFACT_CUSTOM_FIELD_CAPABILITIES}
    />
  );
}

export function ArtifactOptionsMenu(props: {
  columns: readonly ColumnDefinition[];
  columnIds: Set<string>;
  customFields: CustomFieldDefinition[];
  metricDefinitions: readonly Omit<ArtifactListSummaryMetric, "value">[];
  metricKeys: Set<string>;
  setColumnIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setMetricKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  return <TableToolbarOptionsMenu {...props} />;
}

export function ArtifactViewMenu(props: {
  columns: readonly ColumnDefinition[];
  columnIds: Set<string>;
  customFields: CustomFieldDefinition[];
  groupBy: string;
  /** Visible name of the host's leading column. Defaults to "Artifact". */
  leadingLabel?: string;
  secondaryGroupBy: string;
  metricKeys: Set<string>;
  metricDefinitions: readonly Omit<ArtifactListSummaryMetric, "value">[];
  onAddField: () => void;
  onClearSort: () => void;
  onSort: (column: string) => void;
  setColumnIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setGroupBy: (groupBy: string) => void;
  setSecondaryGroupBy: (groupBy: string) => void;
  setMetricKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  showAddFieldButton: boolean;
  sortBy: string;
}) {
  return (
    <TableToolbarViewMenu
      {...props}
      customFieldCapabilities={ARTIFACT_CUSTOM_FIELD_CAPABILITIES}
    />
  );
}

export function applyArtifactBulkMutation(
  artifact: GenericArtifact,
  action: ArtifactBulkAction,
  value?: string
): GenericArtifact {
  if (action === "add-to-project") {
    return { ...artifact, project: value ?? artifact.project };
  }
  if (action === "assign-owner") {
    const owner = EDITABLE_OWNERS.find((person) => person.name === value);
    return owner
      ? { ...artifact, owner: owner.name, ownerInitials: owner.initials }
      : artifact;
  }
  if (action === "add-tag") {
    if (!value || artifact.tags.includes(value)) {
      return artifact;
    }
    return { ...artifact, tags: [...artifact.tags, value] };
  }
  return artifact;
}

export function ArtifactBulkActionBar({
  count,
  currentTags,
  noun,
  onAction,
  onClear,
  onProjectMove,
  onStatusChange,
  projectMoveDestinations,
  statusOptions,
}: {
  count: number;
  currentTags: TagDefinition[];
  noun: { plural: string; singular: string };
  onAction: (action: ArtifactBulkAction, value?: string) => void;
  onClear: () => void;
  /** Cross-project move; a moved subtree travels whole (ISS-6560). */
  onProjectMove?: (destinationLabel: string) => void;
  onStatusChange?: (key: string) => void;
  projectMoveDestinations?: readonly { id: string; label: string }[];
  statusOptions?: readonly Readonly<{
    facet: ArtifactStatusFacet;
    key: string;
  }>[];
}) {
  const label = `${count} ${count === 1 ? noun.singular : noun.plural} selected`;
  return (
    <div className="contents" data-preserve-artifact-selection="">
      <TableBulkActionBar
        actionLabel={label}
        actions={
          <>
            <TableBulkActionButton
              label="Favorite"
              onClick={() => onAction("favorite")}
            >
              <StarIcon />
            </TableBulkActionButton>
            <BulkPickerAction
              label="Add to project"
              onSelect={(value) => onAction("add-to-project", value)}
              options={PROJECT_OPTIONS}
            >
              <FolderPlusIcon />
            </BulkPickerAction>
            <BulkPickerAction
              label="Assign owner"
              onSelect={(value) => onAction("assign-owner", value)}
              options={EDITABLE_OWNERS.map((owner) => owner.name)}
            >
              <UserRoundIcon />
            </BulkPickerAction>
            <BulkPickerAction
              allowCreate
              label="Add tag"
              onSelect={(value) => onAction("add-tag", value)}
              options={currentTags.map((tag) => tag.label)}
            >
              <TagIcon />
            </BulkPickerAction>
            {onStatusChange && statusOptions?.length ? (
              <BulkStatusPickerAction
                onSelect={onStatusChange}
                options={statusOptions}
              />
            ) : null}
            {onProjectMove && projectMoveDestinations?.length ? (
              <BulkPickerAction
                label="Move to project"
                onSelect={onProjectMove}
                options={projectMoveDestinations.map(
                  (destination) => destination.label
                )}
              >
                <FolderInputIcon />
              </BulkPickerAction>
            ) : null}
            <TableBulkActionButton label="Clear selection" onClick={onClear}>
              <XIcon />
            </TableBulkActionButton>
          </>
        }
      />
    </div>
  );
}

function BulkStatusPickerAction({
  onSelect,
  options,
}: Readonly<{
  onSelect: (key: string) => void;
  options: readonly Readonly<{ facet: ArtifactStatusFacet; key: string }>[];
}>) {
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <BulkPopoverTrigger label="Change status">
        <CircleDotDashedIcon />
      </BulkPopoverTrigger>
      <PopoverContent
        align="center"
        className="w-64 p-2"
        data-preserve-artifact-selection=""
        side="top"
      >
        <div className="space-y-1">
          {options.map((option) => (
            <button
              className="flex h-9 w-full items-center rounded-sm px-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              key={option.key}
              onClick={() => {
                onSelect(option.key);
                setOpen(false);
              }}
              type="button"
            >
              <UniversalArtifactStatus
                facet={option.facet}
                variant={ArtifactStatusVariant.BulkOption}
              />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function BulkPickerAction({
  allowCreate = false,
  children,
  label,
  onSelect,
  options,
}: {
  allowCreate?: boolean;
  children: ReactNode;
  label: string;
  onSelect: (value: string) => void;
  options: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOptions = options.filter((option) =>
    option.toLowerCase().includes(normalizedQuery)
  );
  const canCreate =
    allowCreate &&
    normalizedQuery.length > 0 &&
    !options.some((option) => option.toLowerCase() === normalizedQuery);
  const choose = (value: string) => {
    onSelect(value);
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setQuery("");
        }
      }}
      open={open}
    >
      <BulkPopoverTrigger label={label}>{children}</BulkPopoverTrigger>
      <PopoverContent
        align="center"
        className="w-64 p-2"
        data-preserve-artifact-selection=""
        side="top"
      >
        <Input
          aria-label={`Search ${label.toLowerCase()}`}
          className="h-8"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          value={query}
        />
        <div className="mt-2 max-h-56 overflow-y-auto">
          {matchingOptions.map((option) => (
            <button
              className="flex h-9 w-full items-center rounded-sm px-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              key={option}
              onClick={() => choose(option)}
              type="button"
            >
              <span className="truncate">{option}</span>
            </button>
          ))}
          {canCreate ? (
            <button
              className="flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              onClick={() => choose(query.trim())}
              type="button"
            >
              <PlusIcon className="size-3.5 text-muted-foreground" />
              <span className="truncate">Create “{query.trim()}”</span>
            </button>
          ) : null}
          {matchingOptions.length === 0 && !canCreate ? (
            <p className="px-2 py-3 text-muted-foreground text-sm">
              No matches
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const PROJECT_OPTIONS = [
  "Ottilie August Strategic Projects",
  "Artifact foundations",
  "Design system",
  "Platform",
];

function BulkPopoverTrigger({
  children,
  label,
}: Readonly<{ children: ReactNode; label: string }>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PopoverTrigger asChild>
          <button
            aria-label={label}
            className={TABLE_BULK_ACTION_BUTTON_CLASS_NAME}
            type="button"
          >
            {children}
          </button>
        </PopoverTrigger>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
