"use client";

import { ColorSwatchGrid } from "@repo/app/shared/components/color-swatch-picker";
import { TagChip, type TagColor } from "@repo/app/shared/components/tag-chip";
import {
  pickTagColorLabel,
  TAG_COLOR_PALETTE,
} from "@repo/app/shared/components/tag-color-picker";
import {
  Avatar,
  AvatarFallback,
  avatarInitial,
} from "@repo/design-system/components/ui/avatar";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  InlineReferenceCell,
  type InlineReferenceOption,
} from "@repo/design-system/components/ui/inline-reference-cell";
import {
  InlineMultiSelectCell,
  InlineSelectCell,
  type InlineSelectOption,
} from "@repo/design-system/components/ui/inline-select-cell";
import { InlineTagCell } from "@repo/design-system/components/ui/inline-tag-cell";
import { compareMonoIds } from "@repo/design-system/components/ui/mono-id-cell";
import { toast } from "@repo/design-system/components/ui/sonner";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { compareNullableNumber } from "@repo/lib/sort-comparators";
import { LinkIcon, PlusIcon } from "lucide-react";
import { useContext, useEffect, useState } from "react";
import {
  genericArtifactStatusRank,
  genericArtifactStatusRawRank,
} from "../../generic-artifact-status";
import type { GenericArtifact } from "../fixtures";
import { customFieldValues } from "./artifact-list-custom-field-model";
import {
  INITIAL_TAG_DEFINITIONS,
  type TagDefinition,
  TagEditorContext,
} from "./artifact-list-model";
import { EDITABLE_OWNERS } from "./artifact-list-owners";
import type { ReferenceOption } from "./artifact-list-related-sessions";
import {
  TagsCell,
  useResponsiveVisibleCount,
} from "./artifact-list-responsive-chips";

/**
 * PRD-722 (ISS-9349): a thin adapter over the open-list tag champion. It owns
 * the fixture state, the tag identity (the canonical `TagChip` colours) and
 * the words; the picking, creating and refusal rollback are `InlineTagCell`'s.
 */
export function EditableTagsCell({
  initialTags,
  onChange,
}: {
  initialTags: readonly string[];
  onChange?: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState<readonly string[]>(initialTags);
  useEffect(() => setTags(initialTags), [initialTags]);
  const tagEditor = useContext(TagEditorContext);
  const definitions = tagEditor?.definitions ?? INITIAL_TAG_DEFINITIONS;
  const chip = (label: string, onRemove?: () => void) => (
    <TagChip
      onRemove={onRemove}
      tag={{ color: tagColorFor(definitions, label), id: label, name: label }}
    />
  );
  return (
    <InlineTagCell
      createdContent={(created, finish) => (
        <div className="p-4">
          <div className="mb-3 font-medium text-sm">
            {pickTagColorLabel(created)}
          </div>
          <ColorSwatchGrid
            columns={8}
            onSelect={(color) => {
              tagEditor?.setTagColor(created, color);
              finish();
            }}
            palette={TAG_COLOR_PALETTE}
            selectedName={tagColorFor(definitions, created)}
          />
        </div>
      )}
      label="tags"
      onCommit={(next) => {
        setTags(next);
        onChange?.([...next]);
      }}
      onCreate={(label) => tagEditor?.createTag(label)}
      options={definitions.map((definition) => ({
        value: definition.label,
        label: definition.label,
        content: chip(definition.label),
      }))}
      renderSelected={(value, remove) => chip(value, remove)}
      renderValues={(values) => <TagsCell tags={values} />}
      search={{
        label: "Search or create tags",
        placeholder: "Search or create tag…",
        createLabel: (query) => `Create tag “${query}”`,
        emptyMessage: "Type to find or create a tag",
      }}
      values={tags}
    />
  );
}

/**
 * The canonical colour of a tag label, for the `TagSummary` the shared
 * {@link TagChip} takes. A label with no definition yet falls back to the first
 * canonical colour rather than a prototype-only "no colour" state: the API's
 * own `pickDefaultColor` (`apps/api/app/tags/service.ts`) always assigns a real
 * `TagColor` on create, so an uncoloured tag is not a state production has.
 */
function tagColorFor(
  definitions: readonly TagDefinition[],
  label: string
): TagColor {
  return (
    definitions.find((definition) => definition.label === label)?.color ??
    TAG_COLOR_PALETTE[0].name
  );
}

export function EditableOwnerCell({
  initialInitials,
  initialOwner,
  onChange,
}: {
  initialInitials: string;
  initialOwner: string;
  onChange?: (owner: Pick<GenericArtifact, "owner" | "ownerInitials">) => void;
}) {
  const [owner, setOwner] = useState({
    name: initialOwner,
    initials: initialInitials,
  });
  useEffect(
    () => setOwner({ name: initialOwner, initials: initialInitials }),
    [initialInitials, initialOwner]
  );
  return (
    <InlineSelectCell
      label="owner"
      onCommit={(name) => {
        const next = EDITABLE_OWNERS.find((item) => item.name === name);
        if (!next) {
          return;
        }
        const previous = owner;
        setOwner(next);
        onChange?.({ owner: next.name, ownerInitials: next.initials });
        showSavedToast("Owner updated", () => {
          setOwner(previous);
          onChange?.({
            owner: previous.name,
            ownerInitials: previous.initials,
          });
        });
      }}
      options={OWNER_SELECT_OPTIONS}
      value={owner.name}
    />
  );
}

export function EditableSingleSelectCell({
  initialValue,
  label,
  optionColors,
  options,
}: {
  initialValue?: string;
  label: string;
  optionColors: string[];
  options: string[];
}) {
  const [value, setValue] = useState(initialValue ?? "");
  return (
    <InlineSelectCell
      label={label}
      onCommit={(next) => {
        const previous = value;
        setValue(next);
        showSavedToast("Field updated", () => setValue(previous));
      }}
      options={chipSelectOptions(options, optionColors)}
      value={value}
    />
  );
}

export function EditableMultiSelectCell({
  initialValues,
  label,
  optionColors,
  options,
}: {
  initialValues: string[];
  label: string;
  optionColors: string[];
  options: string[];
}) {
  const [values, setValues] = useState<readonly string[]>(initialValues);
  return (
    <InlineMultiSelectCell
      label={label}
      onCommit={(next) => {
        const previous = values;
        setValues(next);
        showSavedToast("Field updated", () => setValues(previous));
      }}
      options={chipSelectOptions(options, optionColors)}
      values={values}
    />
  );
}

/**
 * PRD-722 (ISS-9349): a thin adapter over the reference champion. It owns the
 * fixture state, the query filter over slug and title, how a target renders,
 * and the words; the picking and refusal rollback are `InlineReferenceCell`'s.
 */
export function EditableReferenceCell({
  initialValues,
  multiple,
  options,
  source,
}: {
  initialValues: string[];
  multiple: boolean;
  options: readonly ReferenceOption[];
  source?: string;
}) {
  const [values, setValues] = useState<readonly string[]>(initialValues);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOptions = options.filter((option) =>
    `${option.slug} ${option.title}`.toLowerCase().includes(normalizedQuery)
  );
  const optionById = new Map(options.map((option) => [option.id, option]));
  return (
    <InlineReferenceCell
      done={{ label: "Done", summary: (count) => `${count} selected` }}
      label={`${source ?? "artifact"} reference`}
      listStatus={
        matchingOptions.length === 0 ? (
          <div className="px-3 py-8 text-center text-muted-foreground text-sm">
            No matching artifacts
          </div>
        ) : undefined
      }
      multiple={multiple}
      onCommit={(next) => {
        const previous = values;
        setValues(next);
        setQuery("");
        showSavedToast(
          multiple ? "References updated" : "Reference updated",
          () => setValues(previous)
        );
      }}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("");
        }
      }}
      onQueryChange={setQuery}
      options={matchingOptions.map(referenceCellOption)}
      query={query}
      renderValues={(shown) => (
        <ResponsiveReferenceList options={options} values={[...shown]} />
      )}
      search={{
        label: `Search ${source ?? "artifact"} references`,
        placeholder: `Search ${source ?? "artifacts"}…`,
      }}
      valueLabel={(value) => optionById.get(value)?.slug ?? value}
      values={values}
    />
  );
}

/** A fixture reference, shaped for the champion's option row. */
function referenceCellOption(option: ReferenceOption): InlineReferenceOption {
  const Icon = option.icon;
  return {
    value: option.id,
    label: option.slug,
    description: option.title,
    adornment: <Icon className="size-4 shrink-0 text-muted-foreground" />,
    meta: (
      <>
        {option.relationship ? (
          <span className="text-muted-foreground text-xs">
            {option.relationship === "wrote" ? "Wrote" : "Commented"}
          </span>
        ) : null}
        {option.status ? (
          <Chip
            className={cn(
              option.status === "active"
                ? "border-success/25 bg-success/10 text-success"
                : "border-border bg-muted text-muted-foreground"
            )}
            size="sm"
            variant="outline"
          >
            {option.status === "active" ? "Active" : "Completed"}
          </Chip>
        ) : null}
      </>
    ),
  };
}

export function ResponsiveReferenceList({
  hrefForValue,
  options = [],
  values,
  totalCount,
}: {
  hrefForValue?: (value: string) => string | undefined;
  options?: readonly ReferenceOption[];
  values: string[];
  totalCount?: number;
}) {
  const { containerRef, measurementRefs, visibleCount } =
    useResponsiveVisibleCount(values);

  const optionById = new Map(options.map((option) => [option.id, option]));
  const visibleValues = values.slice(0, visibleCount);
  const hiddenValues = values.slice(visibleCount);
  const overflowCount = (totalCount ?? values.length) - visibleValues.length;
  return (
    <span
      className="relative flex w-full min-w-0 items-center gap-1 overflow-hidden"
      ref={containerRef}
    >
      {visibleValues.map((value, index) => {
        const option = optionById.get(value);
        return (
          <ReferenceBadge
            href={hrefForValue?.(value)}
            key={value}
            option={option}
            // The fit always keeps the first badge; it truncates so the +N
            // beside it stays inside the cell and its tooltip reachable.
            shrinkable={index === 0}
            value={value}
          />
        );
      })}
      {overflowCount > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex h-5 shrink-0 cursor-pointer items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
              +{overflowCount}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex flex-col gap-1">
              {hiddenValues.map((value) =>
                hrefForValue?.(value) ? (
                  <a
                    className="text-xs hover:underline"
                    href={hrefForValue(value)}
                    key={value}
                  >
                    {referenceTooltipLabel(optionById.get(value), value)}
                  </a>
                ) : (
                  <span className="text-xs" key={value}>
                    {referenceTooltipLabel(optionById.get(value), value)}
                  </span>
                )
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}
      <span
        aria-hidden
        className="pointer-events-none absolute flex items-center gap-1 opacity-0"
      >
        {values.map((value, index) => {
          const option = optionById.get(value);
          return (
            <ReferenceBadge
              key={value}
              measureRef={(element) => {
                measurementRefs.current[index] = element;
              }}
              option={option}
              value={value}
            />
          );
        })}
      </span>
    </span>
  );
}

function ReferenceBadge({
  href,
  option,
  value,
  measureRef,
  shrinkable = false,
}: {
  href?: string;
  option?: ReferenceOption;
  value: string;
  measureRef?: (element: HTMLSpanElement | null) => void;
  shrinkable?: boolean;
}) {
  const Icon = option?.icon ?? LinkIcon;
  const isSessionReference = Boolean(
    option?.ownerInitials && option.lastInteractionAt
  );
  const content = (
    <>
      {isSessionReference ? (
        <Avatar className="-ml-1 size-5 shrink-0 border border-current/15 ring-2 ring-background">
          <AvatarFallback className="text-[9px]">
            {avatarInitial(option?.ownerInitials)}
          </AvatarFallback>
        </Avatar>
      ) : (
        <Icon className="size-3 shrink-0 opacity-70" />
      )}
      <span
        className={cn("truncate text-xs", !isSessionReference && "font-mono")}
      >
        {relatedSessionDisplayLabel(option) ?? option?.slug ?? value}
      </span>
    </>
  );
  const className = cn(
    "inline-flex min-w-0 items-center gap-1 border",
    shrinkable ? "shrink" : "shrink-0",
    isSessionReference
      ? "h-5 rounded-full py-0 pr-2 pl-1"
      : "rounded-md px-1.5 py-0.5",
    referenceStatusClassName(option?.status),
    href && "hover:border-foreground/20 hover:text-foreground"
  );
  if (href && !measureRef) {
    return (
      <a
        aria-label={referenceTooltipLabel(option, value)}
        className={className}
        href={href}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        title={referenceTooltipLabel(option, value)}
      >
        {content}
      </a>
    );
  }
  return (
    <span
      className={className}
      ref={measureRef}
      title={referenceTooltipLabel(option, value)}
    >
      {content}
    </span>
  );
}

function relatedSessionDisplayLabel(
  option: ReferenceOption | undefined
): string | undefined {
  if (!option?.lastInteractionAt) {
    return undefined;
  }
  if (!option.lastInteractionDate) {
    return option.lastInteractionAt;
  }
  const [year, month, day] = option.lastInteractionDate.split("-");
  if (!(year && month && day)) {
    return option.lastInteractionAt;
  }
  const today = new Date();
  const isToday =
    today.getFullYear() === Number(year) &&
    today.getMonth() + 1 === Number(month) &&
    today.getDate() === Number(day);
  return isToday ? option.lastInteractionAt : `${month}/${day}`;
}

function referenceTooltipLabel(
  option: ReferenceOption | undefined,
  value: string
): string {
  if (!(option?.ownerName && option.lastInteractionAt)) {
    return option?.slug ?? value;
  }
  let status = "Status unavailable";
  if (option.status === "active") {
    status = "Active";
  } else if (option.status === "completed") {
    status = "Completed";
  }
  let relationship = "Related to artifact";
  if (option.relationship === "wrote") {
    relationship = "Wrote to artifact";
  } else if (option.relationship === "commented") {
    relationship = "Commented on artifact";
  }
  const datePrefix = option.lastInteractionDate
    ? `${option.lastInteractionDate} `
    : "";
  return `${option.slug} · ${option.ownerName} · ${status} · ${relationship} · Most recent interaction ${datePrefix}${option.lastInteractionAt}`;
}

function referenceStatusClassName(status: ReferenceOption["status"]): string {
  if (status === "active") {
    return "border-success/25 bg-success/10 text-success";
  }
  if (status === "completed") {
    return "border-border bg-muted text-muted-foreground";
  }
  return "bg-muted/50";
}

export function showSavedToast(message: string, undo: () => void) {
  toast.success(message, {
    action: {
      label: "Undo",
      onClick: undo,
    },
  });
}

export function EmptyCustomValue() {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground text-sm opacity-0 transition-[opacity,background-color] group-focus-within/cell:bg-muted group-focus-within/cell:opacity-100 group-hover/cell:bg-muted group-hover/cell:opacity-100">
      <PlusIcon className="size-3" />
      Add
    </span>
  );
}

export function genericArtifactSortValue(
  artifact: GenericArtifact,
  columnId: string,
  customFields: CustomFieldDefinition[],
  referenceArtifacts: readonly GenericArtifact[]
): string | number | null {
  const customField = customFields.find((field) => field.id === columnId);
  if (customField) {
    const values = customFieldValues(artifact, customField, referenceArtifacts);
    return values.numericValue ?? values.textValues.join(" ");
  }
  switch (columnId) {
    case "collaborators":
      return artifact.collaborators.join(" ");
    case "status":
      return genericArtifactStatusRank(artifact);
    case "tags":
      return artifact.tags.join(" ");
    // ISS-6384: the version's sort value is the version AS RENDERED, not a
    // digit-stripped number. `Number(replace(/\D/g, ""))` read `v1.10` as 110
    // and `v1.9` as 19, so a sort put 1.10 after 1.9 — and the group label this
    // same function feeds read "110" for a row displaying `v1.10`. Ordering is
    // `compareMonoIds`' job (see `genericArtifactCompare`), which walks digit
    // and text runs so `v1.9 < v1.10 < v2.0` holds against this representation.
    case "currentVersion":
      return artifact.currentVersion;
    case "comments":
      return artifact.commentCount ?? null;
    case "owner":
      return artifact.owner;
    case "updated":
      return -artifact.updatedAgoMinutes;
    default:
      return artifact.title;
  }
}

/**
 * ISS-6384: ordering for a `genericArtifactSortValue` pair.
 *
 * The version column's sort value is now the version string itself, so a plain
 * `localeCompare` would order `v1.10` before `v1.9` — the same wrong answer the
 * digit-stripping it replaced gave, arrived at differently. `compareMonoIds`
 * (`@repo/design-system`) walks digit and text runs, which is the ordering that
 * matches how the value is RENDERED. Every other column keeps the numeric or
 * lexical comparison it had.
 */
export function genericArtifactCompare(
  left: string | number | null,
  right: string | number | null,
  columnId: string
): number {
  if (columnId === MONO_ID_COLUMN_ID) {
    return compareMonoIds(String(left), String(right));
  }
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

/** Status ordering keeps unknown last before applying direction. */
export function compareGenericArtifactStatus(
  left: GenericArtifact,
  right: GenericArtifact,
  direction: SortDirection
): number {
  const rootComparison = compareNullableNumber(
    genericArtifactStatusRank(left),
    genericArtifactStatusRank(right),
    direction
  );
  if (rootComparison !== 0) {
    return rootComparison;
  }
  return compareNullableNumber(
    genericArtifactStatusRawRank(left),
    genericArtifactStatusRawRank(right),
    direction
  );
}

/** The one column whose value is a mono id rather than a number or free text. */
const MONO_ID_COLUMN_ID = "currentVersion";

/**
 * The prototype's option lists, shaped for the shared cell. The colour classes
 * stay here because they are fixture values; the champion takes them as an
 * opaque class string rather than knowing the prototype's palette.
 */
function chipSelectOptions(
  options: string[],
  optionColors: string[]
): InlineSelectOption[] {
  return options.map((option, index) => ({
    value: option,
    label: option,
    chipClassName: optionColors[index]
      ? cn(optionColors[index], "border-transparent text-white")
      : undefined,
  }));
}

/** The fixture roster, shaped for the shared cell. Never a component prop. */
const OWNER_SELECT_OPTIONS: InlineSelectOption[] = EDITABLE_OWNERS.map(
  (item) => ({
    value: item.name,
    label: item.name,
    adornment: (
      <Avatar className="size-5">
        <AvatarFallback className="text-[9px]">
          {avatarInitial(item.initials)}
        </AvatarFallback>
      </Avatar>
    ),
  })
);
