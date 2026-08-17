// biome-ignore-all lint/style/noExcessiveLinesPerFile: The prototype keeps closely related list controls together while their shared interaction contract is being validated.
"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
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
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  ActivityIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BookmarkIcon,
  CheckIcon,
  CircleDotDashedIcon,
  EllipsisIcon,
  EyeIcon,
  EyeOffIcon,
  FolderPlusIcon,
  GitCommitIcon,
  GripVerticalIcon,
  GroupIcon,
  Layers2Icon,
  MessageSquareIcon,
  PlusIcon,
  Settings2Icon,
  ShapesIcon,
  SortAscIcon,
  StarIcon,
  TagIcon,
  UserIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import type * as React from "react";
import { type ReactNode, useState } from "react";
import {
  ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "../mock";
import type {
  ArtifactCreationConfig,
  ArtifactCreationField,
  ArtifactCreationValues,
} from "./artifact-creation";
import { ArtifactTypeIcons } from "./artifact-icons";
import {
  type ArtifactBulkAction,
  type ArtifactListSummaryMetric,
  EDITABLE_OWNERS,
  isCustomFieldGroupable,
  isCustomFieldSortable,
  type TagDefinition,
} from "./artifact-list-model";
import type { CustomFieldDefinition } from "./custom-field-dialog";
import type { GridTableColumn } from "./experimental/grid-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./experimental/tooltip";

export type ArtifactSavedView = {
  id: string;
  name: string;
  scope: "personal" | "project" | "team";
};

export function ArtifactSavedViewsMenu({
  activeViewId,
  onApply,
  onSave,
  views,
}: {
  activeViewId: string;
  onApply: (viewId: string) => void;
  onSave: (name: string) => void;
  views: readonly ArtifactSavedView[];
}) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const activeName = views.find((view) => view.id === activeViewId)?.name;
  const scopes = [
    ["personal", "Personal views"],
    ["team", "Team views"],
    ["project", "Project views"],
  ] as const;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline">
            <BookmarkIcon />
            {activeName ?? "Views"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 p-2">
          {scopes.map(([scope, label], index) => {
            const scopedViews = views.filter((view) => view.scope === scope);
            if (scopedViews.length === 0) {
              return null;
            }
            return (
              <div key={scope}>
                {index > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="text-muted-foreground">
                  {label}
                </DropdownMenuLabel>
                {scopedViews.map((view) => (
                  <DropdownMenuItem
                    className="gap-2"
                    key={view.id}
                    onSelect={() => onApply(view.id)}
                  >
                    <CheckIcon
                      className={cn(
                        "size-3.5",
                        view.id === activeViewId ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span className="truncate">{view.name}</span>
                  </DropdownMenuItem>
                ))}
              </div>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
            <PlusIcon />
            Save current view
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog onOpenChange={setSaveOpen} open={saveOpen}>
        <DialogContent className="gap-0 p-0 sm:max-w-md">
          <DialogHeader className="border-b px-5 py-4">
            <DialogTitle>Save current view</DialogTitle>
            <DialogDescription>
              Save filters, sorting, grouping, metrics, and columns as a
              personal view.
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-5">
            <label className="space-y-2 text-sm" htmlFor="saved-view-name">
              <span className="font-medium">View name</span>
              <Input
                autoFocus
                id="saved-view-name"
                onChange={(event) => setName(event.target.value)}
                placeholder="My artifact view"
                value={name}
              />
            </label>
          </div>
          <DialogFooter className="border-t px-5 py-3">
            <Button onClick={() => setSaveOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={!name.trim()}
              onClick={() => {
                onSave(name.trim());
                setName("");
                setSaveOpen(false);
              }}
            >
              Save view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ArtifactSortMenu({
  active,
  columns,
  customFields,
  onClear,
  onSort,
  sortBy,
}: {
  active: boolean;
  columns: readonly (GridTableColumn & { width: string })[];
  customFields: CustomFieldDefinition[];
  onClear: () => void;
  onSort: (column: string, direction: SortDirection) => void;
  sortBy: string;
}) {
  const sortableColumns = [
    {
      icon: <Layers2Icon className="size-4 text-muted-foreground" />,
      id: "name",
      label: "Artifact",
    },
    ...columns
      .filter((column) => column.sortable)
      .map((column) => ({
        icon: <SortFieldIcon columnId={column.id} />,
        id: column.id,
        label: column.label,
      })),
    ...customFields.filter(isCustomFieldSortable).map((field) => ({
      icon: <Settings2Icon className="size-4 text-muted-foreground" />,
      id: field.id,
      label: field.label,
    })),
  ];
  const activeLabel =
    sortableColumns.find((column) => column.id === sortBy)?.label ?? "Artifact";
  return (
    <DropdownMenu>
      <div className="flex items-center">
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`Sort by ${activeLabel}`}
            className={cn(
              active &&
                "rounded-r-none border-primary/20 bg-primary/10 text-primary hover:bg-primary/15"
            )}
            size="sm"
            variant="outline"
          >
            <SortAscIcon />
            {active ? "Sorts: 1" : "Sort"}
          </Button>
        </DropdownMenuTrigger>
        {active ? (
          <button
            aria-label="Clear sorts"
            className="flex h-8 w-8 items-center justify-center rounded-r-md border border-primary/20 border-l-0 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            onClick={onClear}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
      </div>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Sort by</DropdownMenuLabel>
        {sortableColumns.map((column) => (
          <DropdownMenuItem
            key={column.id}
            onSelect={() => onSort(column.id, "asc")}
          >
            {column.icon}
            {column.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortFieldIcon({ columnId }: { columnId: string }) {
  const Icon =
    {
      comments: MessageSquareIcon,
      currentVersion: GitCommitIcon,
      owner: UserIcon,
      relatedSessions: ArtifactTypeIcons.Session,
      status: CircleDotDashedIcon,
      tags: TagIcon,
      type: ShapesIcon,
      updated: ActivityIcon,
    }[columnId] ?? Settings2Icon;
  return <Icon className="size-4 text-muted-foreground" />;
}

export function LegacyAddArtifactDialog({
  config,
  customFields,
  onCreate,
  onOpenChange,
  open,
}: {
  config: ArtifactCreationConfig;
  customFields: readonly CustomFieldDefinition[];
  onCreate: (values: ArtifactCreationValues) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [owner, setOwner] = useState("Andrew Eye");
  const [status, setStatus] = useState<ArtifactStatus>(ArtifactStatus.Active);
  const [project, setProject] = useState("Artifact foundations");
  const [repository, setRepository] = useState("symphony-alpha");
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [linkedArtifacts, setLinkedArtifacts] = useState<string[]>([]);
  const [customValues, setCustomValues] = useState<
    Record<string, string | number | readonly string[] | null>
  >({});
  const requiredFieldsComplete = (config.fields ?? [])
    .filter((field) => field.required)
    .every((field) => {
      const value = customValues[field.id];
      return Array.isArray(value)
        ? value.length > 0
        : String(value ?? "").trim();
    });
  const reset = () => {
    setTitle("");
    setSummary("");
    setOwner("Andrew Eye");
    setStatus(ArtifactStatus.Active);
    setProject("Artifact foundations");
    setRepository("symphony-alpha");
    setCollaborators([]);
    setTags([]);
    setLinkedArtifacts([]);
    setCustomValues({});
  };
  const create = () => {
    const nextTitle = title.trim();
    if (!(nextTitle && requiredFieldsComplete)) {
      return;
    }
    onCreate({
      collaborators,
      customValues,
      linkedArtifacts,
      owner,
      project: project || null,
      repository: config.includeRepository ? repository || null : null,
      status,
      summary: summary.trim(),
      tags,
      title: nextTitle,
    });
    reset();
    onOpenChange(false);
  };
  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          reset();
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent className="flex max-h-[min(860px,calc(100vh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Add {config.noun}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <label className="block space-y-2" htmlFor="new-artifact-name">
            <span className="font-medium text-sm">
              {config.noun[0]?.toUpperCase()}
              {config.noun.slice(1)} name{" "}
              <span className="text-destructive">*</span>
            </span>
            <Input
              autoFocus
              id="new-artifact-name"
              onChange={(event) => setTitle(event.target.value)}
              placeholder={`Name this ${config.noun}`}
              value={title}
            />
          </label>

          <label className="block space-y-2" htmlFor="new-artifact-summary">
            <span className="font-medium text-sm">Summary or description</span>
            <Textarea
              id="new-artifact-summary"
              onChange={(event) => setSummary(event.target.value)}
              placeholder={`Describe the purpose of this ${config.noun}`}
              value={summary}
            />
          </label>

          <section>
            <h3 className="mb-3 font-medium text-sm">Shared artifact fields</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <CreationSelect
                label="Owner"
                onChange={setOwner}
                options={EDITABLE_OWNERS.map((person) => person.name)}
                value={owner}
              />
              <CreationSelect
                label="Status"
                onChange={(value) => setStatus(value as ArtifactStatus)}
                options={Object.values(ArtifactStatus)}
                value={status}
              />
              <CreationSelect
                label="Project"
                onChange={setProject}
                options={[
                  "Artifact foundations",
                  "Andrew August Strategic Projects",
                  "Platform Engineering",
                ]}
                value={project}
              />
              {config.includeRepository ? (
                <CreationSelect
                  label="Repository"
                  onChange={setRepository}
                  options={[
                    "symphony-alpha",
                    "closedloop-web",
                    "closedloop-api",
                  ]}
                  value={repository}
                />
              ) : null}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <CreationMultiSelect
                label="Collaborators"
                onChange={setCollaborators}
                options={EDITABLE_OWNERS.map((person) => person.name).filter(
                  (name) => name !== owner
                )}
                values={collaborators}
              />
              <CreationMultiSelect
                label="Tags"
                onChange={setTags}
                options={[
                  "Foundations",
                  "Product",
                  "Prototype",
                  "Research",
                  "UX",
                ]}
                values={tags}
              />
            </div>
            <div className="mt-4">
              <CreationMultiSelect
                label="Linked artifacts"
                onChange={setLinkedArtifacts}
                options={genericArtifacts.map(
                  (artifact) => `${artifact.slug} ${artifact.title}`
                )}
                values={linkedArtifacts}
              />
            </div>
          </section>

          {config.fields?.length || customFields.length ? (
            <section className="border-t pt-5">
              <h3 className="font-medium text-sm">
                {config.noun[0]?.toUpperCase()}
                {config.noun.slice(1)} and custom fields
              </h3>
              <p className="mt-1 text-muted-foreground text-sm">
                Artifact-specific fields follow the shared schema. Visible
                custom fields are included automatically.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {[
                  ...(config.fields ?? []),
                  ...customFields.map(customFieldToCreationField),
                ].map((field) => (
                  <CreationFieldControl
                    field={field}
                    key={field.id}
                    onChange={(value) =>
                      setCustomValues((current) => ({
                        ...current,
                        [field.id]: value,
                      }))
                    }
                    value={customValues[field.id]}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
        <DialogFooter className="border-t px-5 py-3">
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!(title.trim() && requiredFieldsComplete)}
            onClick={create}
          >
            Create {config.noun}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreationSelect({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: readonly string[];
  value: string;
}) {
  return (
    <div className="space-y-2">
      <span className="font-medium text-sm">{label}</span>
      <Select onValueChange={onChange} value={value}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
        </SelectTrigger>
        <SelectContent align="start">
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CreationMultiSelect({
  label,
  onChange,
  options,
  values,
}: {
  label: string;
  onChange: (values: string[]) => void;
  options: readonly string[];
  values: readonly string[];
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-sm">{label}</legend>
      <div className="flex min-h-9 flex-wrap gap-1 rounded-md border border-input-border bg-input p-1.5">
        {options.map((option) => {
          const selected = values.includes(option);
          return (
            <Button
              aria-pressed={selected}
              className="h-6 px-2 text-xs"
              key={option}
              onClick={() =>
                onChange(
                  selected
                    ? values.filter((value) => value !== option)
                    : [...values, option]
                )
              }
              size="sm"
              type="button"
              variant={selected ? "secondary" : "ghost"}
            >
              {selected ? <CheckIcon /> : <PlusIcon />}
              <span className="max-w-48 truncate">{option}</span>
            </Button>
          );
        })}
      </div>
    </fieldset>
  );
}

function CreationFieldControl({
  field,
  onChange,
  value,
}: {
  field: ArtifactCreationField;
  onChange: (value: string | number | readonly string[] | null) => void;
  value: string | number | readonly string[] | null | undefined;
}) {
  if (field.type === "select") {
    return (
      <CreationSelect
        label={`${field.label}${field.required ? " *" : ""}`}
        onChange={onChange}
        options={field.options ?? []}
        value={typeof value === "string" ? value : ""}
      />
    );
  }
  if (field.type === "multi-select") {
    return (
      <CreationMultiSelect
        label={`${field.label}${field.required ? " *" : ""}`}
        onChange={onChange}
        options={field.options ?? []}
        values={Array.isArray(value) ? value : []}
      />
    );
  }
  if (field.type === "textarea") {
    return (
      <label
        className="space-y-2 sm:col-span-2"
        htmlFor={`creation-${field.id}`}
      >
        <span className="font-medium text-sm">
          {field.label}
          {field.required ? " *" : ""}
        </span>
        <Textarea
          id={`creation-${field.id}`}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
        />
      </label>
    );
  }
  return (
    <label className="space-y-2" htmlFor={`creation-${field.id}`}>
      <span className="font-medium text-sm">
        {field.label}
        {field.required ? " *" : ""}
      </span>
      <Input
        id={`creation-${field.id}`}
        onChange={(event) =>
          onChange(
            field.type === "number"
              ? Number(event.target.value)
              : event.target.value
          )
        }
        placeholder={field.placeholder}
        type={creationInputType(field)}
        value={
          typeof value === "number" || typeof value === "string" ? value : ""
        }
      />
    </label>
  );
}

function customFieldToCreationField(
  field: CustomFieldDefinition
): ArtifactCreationField {
  const type = customFieldCreationType(field);
  return {
    description: field.description,
    id: field.id,
    label: field.label,
    options:
      field.options ??
      (field.type.startsWith("Reference")
        ? genericArtifacts.map((artifact) => artifact.slug)
        : undefined),
    type,
  };
}

function creationInputType(
  field: ArtifactCreationField
): "date" | "number" | "text" {
  if (field.type === "number") {
    return "number";
  }
  return field.type === "date" ? "date" : "text";
}

function customFieldCreationType(
  field: CustomFieldDefinition
): ArtifactCreationField["type"] {
  if (field.type === "Single-select") {
    return "select";
  }
  if (field.type === "Multi-select" || field.type === "Reference (multi)") {
    return "multi-select";
  }
  if (field.type === "Date") {
    return "date";
  }
  if (field.type === "Number" || field.type === "Time") {
    return "number";
  }
  return "text";
}

export function ArtifactGroupMenu({
  columns,
  customFields,
  groupBy,
  secondaryGroupBy,
  setGroupBy,
  setSecondaryGroupBy,
  groupOrder,
  secondaryGroupOrder,
  setGroupOrder,
  setSecondaryGroupOrder,
  showEmptyGroups,
  setShowEmptyGroups,
  showEmptySubgroups,
  setShowEmptySubgroups,
}: {
  columns: readonly (GridTableColumn & { width: string })[];
  customFields: CustomFieldDefinition[];
  groupBy: string;
  secondaryGroupBy: string;
  setGroupBy: (groupBy: string) => void;
  setSecondaryGroupBy: (groupBy: string) => void;
  groupOrder: "custom" | "asc" | "desc";
  secondaryGroupOrder: "custom" | "asc" | "desc";
  setGroupOrder: (order: "custom" | "asc" | "desc") => void;
  setSecondaryGroupOrder: (order: "custom" | "asc" | "desc") => void;
  showEmptyGroups: boolean;
  setShowEmptyGroups: (show: boolean) => void;
  showEmptySubgroups: boolean;
  setShowEmptySubgroups: (show: boolean) => void;
}) {
  const groupableColumns = [
    ...columns.filter((column) => column.groupable),
    ...customFields.filter(isCustomFieldGroupable),
  ];
  const groupCount =
    Number(groupBy !== "none") + Number(secondaryGroupBy !== "none");
  const removePrimary = () => {
    if (secondaryGroupBy !== "none") {
      setGroupBy(secondaryGroupBy);
      setGroupOrder(secondaryGroupOrder);
      setSecondaryGroupBy("none");
      setSecondaryGroupOrder("asc");
      return;
    }
    setGroupBy("none");
  };
  const swapGroups = () => {
    if (secondaryGroupBy === "none") {
      return;
    }
    const nextPrimary = secondaryGroupBy;
    const nextPrimaryOrder = secondaryGroupOrder;
    setSecondaryGroupBy(groupBy);
    setSecondaryGroupOrder(groupOrder);
    setGroupBy(nextPrimary);
    setGroupOrder(nextPrimaryOrder);
  };

  return (
    <Popover>
      <div className="flex items-center">
        <PopoverTrigger asChild>
          <Button
            className={cn(
              groupBy !== "none" &&
                "rounded-r-none border-primary/20 bg-primary/10 text-primary hover:bg-primary/15"
            )}
            size="sm"
            variant="outline"
          >
            <GroupIcon />
            {groupCount === 0 ? "Group" : `Groups: ${groupCount}`}
          </Button>
        </PopoverTrigger>
        {groupBy === "none" ? null : (
          <button
            aria-label="Clear groups"
            className="flex h-8 w-8 items-center justify-center rounded-r-md border border-primary/20 border-l-0 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
            onClick={() => {
              setGroupBy("none");
              setSecondaryGroupBy("none");
              setGroupOrder("custom");
              setSecondaryGroupOrder("asc");
            }}
            type="button"
          >
            <XIcon className="size-4" />
          </button>
        )}
      </div>
      <PopoverContent
        align="end"
        className="w-[min(38rem,calc(100vw-2rem))] space-y-4 p-5"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-base">Groups</h3>
            <button
              className="text-muted-foreground text-sm underline-offset-4 hover:underline"
              type="button"
            >
              Send feedback
            </button>
          </div>
          {groupCount > 0 ? (
            <Button
              onClick={() => {
                setGroupBy("none");
                setSecondaryGroupBy("none");
                setGroupOrder("custom");
                setSecondaryGroupOrder("asc");
              }}
              size="sm"
              variant="ghost"
            >
              Clear
            </Button>
          ) : null}
        </div>
        {groupBy === "none" ? (
          <EmptyGroupingEditorRow
            columns={groupableColumns}
            onSelect={(value) => setGroupBy(value)}
          />
        ) : (
          <div className="space-y-3">
            <GroupingEditorRow
              columns={groupableColumns}
              excludedValue={secondaryGroupBy}
              level="primary"
              onFieldChange={setGroupBy}
              onOrderChange={setGroupOrder}
              onRemove={removePrimary}
              onShowEmptyGroupsChange={setShowEmptyGroups}
              onSwap={swapGroups}
              order={groupOrder}
              showEmptyGroups={showEmptyGroups}
              value={groupBy}
            />
            {secondaryGroupBy === "none" ? (
              <GroupFieldPicker
                columns={groupableColumns.filter(
                  (column) => column.id !== groupBy
                )}
                label="Add subgroup"
                onSelect={setSecondaryGroupBy}
              />
            ) : (
              <GroupingEditorRow
                columns={groupableColumns}
                excludedValue={groupBy}
                level="secondary"
                onFieldChange={setSecondaryGroupBy}
                onOrderChange={setSecondaryGroupOrder}
                onRemove={() => setSecondaryGroupBy("none")}
                onShowEmptyGroupsChange={setShowEmptySubgroups}
                onSwap={swapGroups}
                order={secondaryGroupOrder}
                showEmptyGroups={showEmptySubgroups}
                value={secondaryGroupBy}
              />
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function EmptyGroupingEditorRow({
  columns,
  onSelect,
}: {
  columns: readonly { id: string; label: string }[];
  onSelect: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2">
      <GripVerticalIcon className="size-4 text-muted-foreground/50" />
      <Select onValueChange={onSelect}>
        <SelectTrigger aria-label="Primary grouping field" className="w-full">
          <SelectValue placeholder="Select group" />
        </SelectTrigger>
        <SelectContent>
          {columns.map((column) => (
            <SelectItem key={column.id} value={column.id}>
              {column.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select disabled value="asc">
        <SelectTrigger aria-label="Primary group order" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="asc">Ascending</SelectItem>
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
  columns,
  label,
  onSelect,
}: {
  columns: readonly { id: string; label: string }[];
  label: string;
  onSelect: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="justify-start" size="sm" variant="ghost">
          <PlusIcon /> {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {columns.map((column) => (
          <DropdownMenuItem
            key={column.id}
            onSelect={() => onSelect(column.id)}
          >
            {column.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GroupingEditorRow({
  columns,
  excludedValue,
  level,
  onFieldChange,
  onOrderChange,
  onRemove,
  onShowEmptyGroupsChange,
  onSwap,
  order,
  showEmptyGroups,
  value,
}: {
  columns: readonly { id: string; label: string }[];
  excludedValue: string;
  level: "primary" | "secondary";
  onFieldChange: (value: string) => void;
  onOrderChange: (value: "custom" | "asc" | "desc") => void;
  onRemove: () => void;
  onShowEmptyGroupsChange: (show: boolean) => void;
  onSwap: () => void;
  order: "custom" | "asc" | "desc";
  showEmptyGroups: boolean;
  value: string;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Grouping levels are draggable reorder targets containing their own accessible controls.
    // biome-ignore lint/a11y/noStaticElementInteractions: Grouping levels are draggable reorder targets containing their own accessible controls.
    <div
      className="group/level grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto] items-center gap-2"
      draggable
      onDragOver={(event) => event.preventDefault()}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/group-level", level);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (event.dataTransfer.getData("text/group-level") !== level) {
          onSwap();
        }
      }}
    >
      <GripVerticalIcon className="size-4 cursor-grab text-muted-foreground" />
      <Select onValueChange={onFieldChange} value={value}>
        <SelectTrigger
          aria-label={`${level} grouping field`}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {columns
            .filter((column) => column.id !== excludedValue)
            .map((column) => (
              <SelectItem key={column.id} value={column.id}>
                {column.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Select
        onValueChange={(next) =>
          onOrderChange(next as "custom" | "asc" | "desc")
        }
        value={order}
      >
        <SelectTrigger aria-label={`${level} group order`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="custom">Custom order</SelectItem>
          <SelectItem value="asc">
            <span className="flex items-center gap-2">
              <ArrowUpIcon className="size-4" />
              Ascending
            </span>
          </SelectItem>
          <SelectItem value="desc">
            <span className="flex items-center gap-2">
              <ArrowDownIcon className="size-4" />
              Descending
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={`${level} group options`}
            size="icon-sm"
            variant="ghost"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            onSelect={() => onShowEmptyGroupsChange(!showEmptyGroups)}
          >
            {showEmptyGroups ? <EyeOffIcon /> : <EyeIcon />}
            {showEmptyGroups ? "Hide empty groups" : "Show empty groups"}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        aria-label={`Remove ${level} group`}
        onClick={onRemove}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </div>
  );
}

function ArtifactGroupingControls({
  groupableColumns,
  groupBy,
  secondaryGroupBy,
  setGroupBy,
  setSecondaryGroupBy,
}: {
  groupableColumns: readonly { id: string; label: string }[];
  groupBy: string;
  secondaryGroupBy: string;
  setGroupBy: (groupBy: string) => void;
  setSecondaryGroupBy: (groupBy: string) => void;
}) {
  const primaryLabel =
    groupableColumns.find((column) => column.id === groupBy)?.label ?? "None";
  const secondaryLabel = groupableColumns.find(
    (column) => column.id === secondaryGroupBy
  )?.label;

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
            onValueChange={(value) => {
              setGroupBy(value);
              if (value === "none" || value === secondaryGroupBy) {
                setSecondaryGroupBy("none");
              }
            }}
            value={groupBy}
          >
            <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
            {groupableColumns.map((field) => (
              <DropdownMenuRadioItem key={field.id} value={field.id}>
                {field.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {groupBy === "none" ? (
        <DropdownMenuItem disabled>
          <PlusIcon />
          Add second group
        </DropdownMenuItem>
      ) : (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="min-h-10">
              <PlusIcon />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-muted-foreground text-xs">
                  Then group by
                </span>
                <span className="truncate font-medium">
                  {secondaryLabel ?? "Add group"}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuLabel className="text-muted-foreground">
                Then group by
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={setSecondaryGroupBy}
                value={secondaryGroupBy}
              >
                <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
                {groupableColumns
                  .filter((field) => field.id !== groupBy)
                  .map((field) => (
                    <DropdownMenuRadioItem key={field.id} value={field.id}>
                      {field.label}
                    </DropdownMenuRadioItem>
                  ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </>
      )}
    </>
  );
}

export function ArtifactViewMenu({
  columns,
  columnIds,
  customFields,
  groupBy,
  secondaryGroupBy,
  metricKeys,
  metricDefinitions,
  onAddField,
  onClearSort,
  onSort,
  setColumnIds,
  setGroupBy,
  setSecondaryGroupBy,
  setMetricKeys,
  showAddFieldButton,
  sortBy,
}: {
  columns: readonly (GridTableColumn & { width: string })[];
  columnIds: Set<string>;
  customFields: CustomFieldDefinition[];
  groupBy: string;
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
  const sortableColumns = [
    { id: "name", label: "Artifact" },
    ...columns.filter((column) => column.sortable),
    ...customFields.filter(isCustomFieldSortable),
  ];
  const groupableColumns = [
    ...columns.filter((column) => column.groupable),
    ...customFields.filter(isCustomFieldGroupable),
  ];
  const allColumns = [
    ...columns.filter((column) => column.id !== "tags"),
    ...customFields,
    ...columns.filter((column) => column.id === "tags"),
  ];
  const toggleSetValue = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string
  ) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2Icon />
          View
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-[min(75vh,40rem)] w-72 overflow-y-auto p-2"
      >
        <DropdownMenuLabel className="text-muted-foreground">
          Sort by
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            value === "none" ? onClearSort() : onSort(value)
          }
          value={sortBy}
        >
          <DropdownMenuRadioItem value="none">None</DropdownMenuRadioItem>
          {sortableColumns.map((column) => (
            <DropdownMenuRadioItem key={column.id} value={column.id}>
              {column.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <ArtifactGroupingControls
          groupableColumns={groupableColumns}
          groupBy={groupBy}
          secondaryGroupBy={secondaryGroupBy}
          setGroupBy={setGroupBy}
          setSecondaryGroupBy={setSecondaryGroupBy}
        />
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground">
          Summary cards
        </DropdownMenuLabel>
        {metricDefinitions.map((metric) => (
          <OptionSwitchRow
            checked={metricKeys.has(metric.key)}
            key={metric.key}
            label={metric.label}
            onChange={() => toggleSetValue(setMetricKeys, metric.key)}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground">
          Show / hide columns
        </DropdownMenuLabel>
        {allColumns.map((column) => (
          <OptionSwitchRow
            checked={columnIds.has(column.id)}
            key={column.id}
            label={column.label}
            onChange={() => toggleSetValue(setColumnIds, column.id)}
          />
        ))}
        {showAddFieldButton ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onAddField}>
              <PlusIcon />
              Add field
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ArtifactOptionsMenu({
  columns,
  columnIds,
  customFields,
  metricDefinitions,
  metricKeys,
  setColumnIds,
  setMetricKeys,
}: {
  columns: readonly (GridTableColumn & { width: string })[];
  columnIds: Set<string>;
  customFields: CustomFieldDefinition[];
  metricDefinitions: readonly Omit<ArtifactListSummaryMetric, "value">[];
  metricKeys: Set<string>;
  setColumnIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setMetricKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const allColumns = [
    ...columns.filter((column) => column.id !== "tags"),
    ...customFields.map((field) => ({ id: field.id, label: field.label })),
    ...columns.filter((column) => column.id === "tags"),
  ];
  const toggleSetValue = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    key: string
  ) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline">
          <Settings2Icon />
          Options
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-[min(70vh,620px)] w-72 overflow-y-auto p-2"
      >
        <DropdownMenuLabel className="text-muted-foreground">
          Summary cards
        </DropdownMenuLabel>
        {metricDefinitions.map((metric) => (
          <OptionSwitchRow
            checked={metricKeys.has(metric.key)}
            key={metric.key}
            label={metric.label}
            onChange={() => toggleSetValue(setMetricKeys, metric.key)}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground">
          Show / hide columns
        </DropdownMenuLabel>
        {allColumns.map((column) => (
          <OptionSwitchRow
            checked={columnIds.has(column.id)}
            key={column.id}
            label={column.label}
            onChange={() => toggleSetValue(setColumnIds, column.id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OptionSwitchRow({
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

export function ArtifactRowUtilities({
  artifact,
  favorited,
  onFavoriteChange,
}: {
  artifact: GenericArtifact;
  favorited: boolean;
  onFavoriteChange: (favorited: boolean) => void;
}) {
  return (
    <div className="flex size-full items-center justify-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-label={
              favorited
                ? `Remove ${artifact.title} from favorites`
                : `Add ${artifact.title} to favorites`
            }
            aria-pressed={favorited}
            className={cn(
              "flex size-full items-center justify-center text-muted-foreground/30 transition-colors hover:text-amber-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              favorited && "text-amber-500"
            )}
            onClick={() => onFavoriteChange(!favorited)}
            type="button"
          >
            <StarIcon
              className="size-4"
              fill={favorited ? "currentColor" : "none"}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {favorited ? "Remove from favorites" : "Add to favorites"}
        </TooltipContent>
      </Tooltip>
    </div>
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
    if (!value) {
      return artifact;
    }
    return artifact.tags.includes(value)
      ? artifact
      : { ...artifact, tags: [...artifact.tags, value] };
  }
  return artifact;
}

export function ArtifactBulkActionBar({
  count,
  currentTags,
  noun,
  onAction,
  onClear,
}: {
  count: number;
  currentTags: TagDefinition[];
  noun: { plural: string; singular: string };
  onAction: (action: ArtifactBulkAction, value?: string) => void;
  onClear: () => void;
}) {
  const [activePicker, setActivePicker] = useState<string | null>(null);
  const tooltipsEnabled = activePicker === null;
  return (
    <div
      aria-label={`${count} ${count === 1 ? noun.singular : noun.plural} selected`}
      aria-live="polite"
      className="fixed bottom-16 left-1/2 z-50 flex h-14 max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center overflow-x-auto rounded-xl bg-neutral-900 px-2 text-white shadow-2xl md:bottom-8 md:gap-1 md:rounded-full md:px-4 dark:bg-neutral-100 dark:text-neutral-950"
      role="toolbar"
    >
      <span className="shrink-0 whitespace-nowrap px-2 font-medium text-xs md:min-w-44 md:px-3 md:text-sm">
        {count} {count === 1 ? noun.singular : noun.plural} selected
      </span>
      <BulkActionButton
        label={`Favorite ${noun.plural}`}
        onClick={() => onAction("favorite")}
        tooltipsEnabled={tooltipsEnabled}
      >
        <StarIcon />
      </BulkActionButton>
      <BulkPickerAction
        activePicker={activePicker}
        label="Add to project"
        onActivePickerChange={setActivePicker}
        onSelect={(value) => onAction("add-to-project", value)}
        options={[
          "Andrew August Strategic Projects",
          "Artifact foundations",
          "Design system",
          "Platform",
        ]}
        pickerId="project"
      >
        <FolderPlusIcon />
      </BulkPickerAction>
      <BulkPickerAction
        activePicker={activePicker}
        label="Assign owner"
        onActivePickerChange={setActivePicker}
        onSelect={(value) => onAction("assign-owner", value)}
        options={EDITABLE_OWNERS.map((owner) => owner.name)}
        pickerId="owner"
      >
        <UserRoundIcon />
      </BulkPickerAction>
      <BulkPickerAction
        activePicker={activePicker}
        allowCreate
        label="Add tag"
        onActivePickerChange={setActivePicker}
        onSelect={(value) => onAction("add-tag", value)}
        options={currentTags.map((tag) => tag.label)}
        pickerId="tag"
      >
        <TagIcon />
      </BulkPickerAction>
      <BulkActionButton
        label="Close"
        onClick={onClear}
        tooltipsEnabled={tooltipsEnabled}
      >
        <XIcon />
      </BulkActionButton>
    </div>
  );
}

function BulkPickerAction({
  activePicker,
  allowCreate = false,
  children,
  label,
  onActivePickerChange,
  onSelect,
  options,
  pickerId,
}: {
  activePicker: string | null;
  allowCreate?: boolean;
  children: ReactNode;
  label: string;
  onActivePickerChange: (pickerId: string | null) => void;
  onSelect: (value: string) => void;
  options: readonly string[];
  pickerId: string;
}) {
  const [query, setQuery] = useState("");
  const open = activePicker === pickerId;
  const matchingOptions = options.filter((option) =>
    option.toLowerCase().includes(query.trim().toLowerCase())
  );
  const canCreate =
    allowCreate &&
    query.trim().length > 0 &&
    !options.some(
      (option) => option.toLowerCase() === query.trim().toLowerCase()
    );
  const choose = (value: string) => {
    onSelect(value);
    onActivePickerChange(null);
    setQuery("");
  };

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        onActivePickerChange(nextOpen ? pickerId : null);
        if (!nextOpen) {
          setQuery("");
        }
      }}
      open={open}
    >
      <Tooltip open={activePicker === null ? undefined : false}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={label}
              className={bulkActionButtonClassName}
              type="button"
            >
              {children}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="center"
        className="w-64 overflow-hidden p-0"
        side="top"
        sideOffset={12}
      >
        <div className="border-b p-2">
          <Input
            aria-label={`Search ${label.toLowerCase()}`}
            className="h-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            value={query}
          />
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
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

const bulkActionButtonClassName =
  "flex size-10 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 dark:text-neutral-950/80 dark:focus-visible:ring-neutral-950/60 dark:hover:bg-black/10 dark:hover:text-neutral-950 [&>svg]:size-[18px]";

function BulkActionButton({
  children,
  label,
  onClick,
  tooltipsEnabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  tooltipsEnabled: boolean;
}) {
  return (
    <Tooltip open={tooltipsEnabled ? undefined : false}>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          className={bulkActionButtonClassName}
          onClick={onClick}
          type="button"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
