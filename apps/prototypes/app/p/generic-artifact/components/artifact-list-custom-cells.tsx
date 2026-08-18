"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { toast } from "@repo/design-system/components/ui/sonner";
import { cn } from "@repo/design-system/lib/utils";
import { CheckIcon, LinkIcon, PlusIcon, XIcon } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import {
  type ArtifactStatus,
  type GenericArtifact,
  genericArtifacts,
} from "../mock";
import {
  customFieldReferenceValues,
  customFieldValues,
  EDITABLE_OWNERS,
  INITIAL_TAG_DEFINITIONS,
  inlineEditorRadioItemClassName,
  kindIcon,
  REFERENCE_SOURCE_KINDS,
  type ReferenceOption,
  statusChipClass,
  TAG_COLOR_OPTIONS,
  type TagColor,
  type TagDefinition,
  TagEditorContext,
  toggleArrayValue,
} from "./artifact-list-model";
import { ResponsiveChipList, TagsCell } from "./artifact-list-responsive-chips";
import type { CustomFieldDefinition } from "./custom-field-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./experimental/tooltip";

const CHIP_GAP_PX = 4;
const CHIP_OVERFLOW_WIDTH_PX = 30;

export function EditableTagsCell({
  initialTags,
  onChange,
}: {
  initialTags: readonly string[];
  onChange?: (tags: string[]) => void;
}) {
  const [tags, setTags] = useState<string[]>([...initialTags]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingNewTag, setPendingNewTag] = useState<string | null>(null);
  useEffect(() => setTags([...initialTags]), [initialTags]);
  const tagEditor = useContext(TagEditorContext);
  const definitions = tagEditor?.definitions ?? INITIAL_TAG_DEFINITIONS;
  const normalizedQuery = query.trim().toLowerCase();
  const matchingDefinitions = definitions.filter((definition) =>
    definition.label.toLowerCase().includes(normalizedQuery)
  );
  const exactMatch = definitions.some(
    (definition) => definition.label.toLowerCase() === normalizedQuery
  );
  const createTag = () => {
    const label = query.trim();
    if (!label || exactMatch) {
      return;
    }
    tagEditor?.createTag(label);
    setTags((current) => {
      const next = current.includes(label) ? current : [...current, label];
      onChange?.(next);
      return next;
    });
    setPendingNewTag(label);
    setQuery("");
  };
  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setPendingNewTag(null);
          setQuery("");
        }
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit tags: ${tags.join(", ") || "none"}`}
          className="group w-full max-w-full rounded-md px-1 py-0.5 text-left hover:bg-muted"
          type="button"
        >
          {tags.length > 0 ? <TagsCell tags={tags} /> : <EmptyCustomValue />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] overflow-hidden p-0">
        <div className="flex min-h-10 flex-wrap items-center gap-1 border-b px-2 py-1.5">
          {tags.map((tag) => (
            <TagEditorChip
              definition={definitions.find(
                (definition) => definition.label === tag
              )}
              key={tag}
              label={tag}
              onRemove={() =>
                setTags((current) => {
                  const next = current.filter((value) => value !== tag);
                  onChange?.(next);
                  return next;
                })
              }
            />
          ))}
          <form
            className="min-w-24 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              const firstMatch = matchingDefinitions[0];
              if (firstMatch) {
                setTags((current) => {
                  const next = current.includes(firstMatch.label)
                    ? current
                    : [...current, firstMatch.label];
                  onChange?.(next);
                  return next;
                });
                setQuery("");
                return;
              }
              createTag();
            }}
          >
            <input
              aria-label="Search or create tags"
              autoFocus
              className="h-7 w-full bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tags.length > 0 ? "" : "Search or create tag…"}
              value={query}
            />
          </form>
        </div>

        {pendingNewTag ? (
          <TagColorPicker
            label={pendingNewTag}
            onChange={(color) => {
              tagEditor?.setTagColor(pendingNewTag, color);
              setPendingNewTag(null);
            }}
          />
        ) : (
          <div className="max-h-64 overflow-y-auto p-1">
            {matchingDefinitions.map((definition) => {
              const selected = tags.includes(definition.label);
              return (
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  key={definition.label}
                  onClick={() => {
                    setTags((current) => {
                      const next = toggleArrayValue(current, definition.label);
                      onChange?.(next);
                      return next;
                    });
                    setQuery("");
                  }}
                  type="button"
                >
                  <TagColorSwatch color={definition.color} />
                  <span className="min-w-0 flex-1 truncate">
                    {definition.label}
                  </span>
                  {selected ? <CheckIcon className="size-4" /> : null}
                </button>
              );
            })}
            {query.trim() && !exactMatch ? (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                onClick={createTag}
                type="button"
              >
                <PlusIcon className="size-4" />
                Create tag “{query.trim()}”
              </button>
            ) : null}
            {matchingDefinitions.length === 0 && !query.trim() ? (
              <div className="px-3 py-6 text-center text-muted-foreground text-sm">
                Type to find or create a tag
              </div>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function TagEditorChip({
  definition,
  label,
  onRemove,
}: {
  definition?: TagDefinition;
  label: string;
  onRemove: () => void;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-36 items-center gap-1 rounded-md border px-1.5 text-xs",
        tagColorClassName(definition?.color ?? "none")
      )}
    >
      <span className="truncate">{label}</span>
      <button
        aria-label={`Remove ${label}`}
        className="-mr-0.5 rounded-sm opacity-60 hover:opacity-100"
        onClick={onRemove}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}

function TagColorPicker({
  label,
  onChange,
}: {
  label: string;
  onChange: (color: TagColor) => void;
}) {
  return (
    <div className="p-4">
      <div className="mb-3 font-medium text-sm">Pick a color for {label}</div>
      <div className="grid grid-cols-8 gap-2">
        {TAG_COLOR_OPTIONS.map((option) => (
          <button
            aria-label={option.color}
            className={cn(
              "size-7 rounded-md border border-transparent transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              option.swatchClassName
            )}
            key={option.color}
            onClick={() => onChange(option.color)}
            type="button"
          />
        ))}
      </div>
    </div>
  );
}

function TagColorSwatch({ color }: { color: TagColor }) {
  const option = TAG_COLOR_OPTIONS.find((item) => item.color === color);
  return (
    <span
      aria-hidden
      className={cn("size-3 shrink-0 rounded-sm", option?.swatchClassName)}
    />
  );
}

function tagColorClassName(color: TagColor): string | undefined {
  return TAG_COLOR_OPTIONS.find((item) => item.color === color)?.chipClassName;
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit owner, currently ${owner.name}`}
          className="flex w-full max-w-full items-center gap-2 rounded-md px-1 py-0.5 text-sm hover:bg-muted"
          type="button"
        >
          <Avatar className="size-6">
            <AvatarFallback className="text-[10px]">
              {owner.initials}
            </AvatarFallback>
          </Avatar>
          <span className="truncate">{owner.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>Owner</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(name) => {
            const nextOwner = EDITABLE_OWNERS.find(
              (item) => item.name === name
            );
            if (nextOwner) {
              const previous = owner;
              setOwner(nextOwner);
              onChange?.({
                owner: nextOwner.name,
                ownerInitials: nextOwner.initials,
              });
              showSavedToast("Owner updated", () => {
                setOwner(previous);
                onChange?.({
                  owner: previous.name,
                  ownerInitials: previous.initials,
                });
              });
            }
          }}
          value={owner.name}
        >
          {EDITABLE_OWNERS.map((item) => (
            <DropdownMenuRadioItem
              className={inlineEditorRadioItemClassName}
              key={item.name}
              value={item.name}
            >
              <Avatar className="size-5">
                <AvatarFallback className="text-[9px]">
                  {item.initials}
                </AvatarFallback>
              </Avatar>
              {item.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EditableSingleSelectCell({
  initialValue,
  optionColors,
  options,
}: {
  initialValue?: string;
  optionColors: string[];
  options: string[];
}) {
  const [value, setValue] = useState(initialValue ?? "");
  const optionIndex = options.indexOf(value);
  const optionColor = optionColors[optionIndex];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit value, currently ${value || "empty"}`}
          className="group rounded-md px-1 py-0.5 text-left hover:bg-muted"
          type="button"
        >
          {value ? (
            <Chip
              className={cn(
                optionColor,
                optionColor && "border-transparent text-white"
              )}
              variant="outline"
            >
              {value}
            </Chip>
          ) : (
            <EmptyCustomValue />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          onValueChange={(nextValue) => {
            const previous = value;
            setValue(nextValue);
            showSavedToast("Field updated", () => setValue(previous));
          }}
          value={value}
        >
          {options.map((item, index) => (
            <DropdownMenuRadioItem
              className={inlineEditorRadioItemClassName}
              key={item}
              value={item}
            >
              <Chip
                className={cn(
                  optionColors[index],
                  optionColors[index] && "border-transparent text-white"
                )}
                variant="outline"
              >
                {item}
              </Chip>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EditableMultiSelectCell({
  initialValues,
  optionColors,
  options,
}: {
  initialValues: string[];
  optionColors: string[];
  options: string[];
}) {
  const [values, setValues] = useState(initialValues);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit values: ${values.join(", ") || "none"}`}
          className="group w-full max-w-full rounded-md px-1 py-0.5 text-left hover:bg-muted"
          type="button"
        >
          {values.length > 0 ? (
            <ResponsiveChipList
              classNameForValue={(value) => {
                const index = options.indexOf(value);
                return cn(
                  optionColors[index],
                  optionColors[index] && "border-transparent text-white"
                );
              }}
              values={values}
              variant="outline"
            />
          ) : (
            <EmptyCustomValue />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {options.map((item) => (
          <DropdownMenuCheckboxItem
            checked={values.includes(item)}
            key={item}
            onCheckedChange={() => {
              const previous = values;
              setValues(toggleArrayValue(values, item));
              showSavedToast("Field updated", () => setValues(previous));
            }}
            onSelect={(event) => event.preventDefault()}
          >
            {item}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EditableReferenceCell({
  initialValues,
  multiple,
  options,
  source,
}: {
  initialValues: string[];
  multiple: boolean;
  options?: readonly ReferenceOption[];
  source?: string;
}) {
  const [values, setValues] = useState(initialValues);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const sourceKind = source ? REFERENCE_SOURCE_KINDS[source] : undefined;
  const referenceOptions: readonly ReferenceOption[] =
    options ??
    genericArtifacts
      .filter((artifact) => !sourceKind || artifact.kind === sourceKind)
      .map((artifact) => ({
        icon: kindIcon[artifact.kind],
        id: artifact.slug,
        slug: artifact.slug,
        title: artifact.title,
      }));
  const matchingOptions = referenceOptions.filter((option) =>
    `${option.slug} ${option.title}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
  const toggleReference = (id: string) => {
    const previous = values;
    const next = multiple ? toggleArrayValue(values, id) : [id];
    setValues(next);
    setQuery("");
    if (!multiple) {
      setOpen(false);
    }
    showSavedToast(multiple ? "References updated" : "Reference updated", () =>
      setValues(previous)
    );
  };
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit ${source ?? "artifact"} reference`}
          className="group w-full max-w-full rounded-md px-1 py-0.5 text-left text-sm hover:bg-muted"
          type="button"
        >
          {values.length ? (
            <ResponsiveReferenceList
              options={referenceOptions}
              values={values}
            />
          ) : null}
          {values.length === 0 ? <EmptyCustomValue /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] overflow-hidden p-0">
        <div className="border-b p-2">
          <div className="flex items-center gap-2 rounded-md border bg-background px-2">
            <LinkIcon className="size-4 text-muted-foreground" />
            <input
              aria-label={`Search ${source ?? "artifact"} references`}
              autoFocus
              className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${source ?? "artifacts"}…`}
              value={query}
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {matchingOptions.map((option) => {
            const selected = values.includes(option.id);
            const Icon = option.icon;
            return (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-muted"
                key={option.id}
                onClick={() => toggleReference(option.id)}
                type="button"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0 font-mono text-muted-foreground text-xs">
                  {option.slug}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {option.title}
                </span>
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
                {selected ? <CheckIcon className="size-4" /> : null}
              </button>
            );
          })}
          {matchingOptions.length === 0 ? (
            <div className="px-3 py-8 text-center text-muted-foreground text-sm">
              No matching artifacts
            </div>
          ) : null}
        </div>
        {multiple && values.length > 0 ? (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {values.length} selected
            </span>
            <Button onClick={() => setOpen(false)} size="sm">
              Done
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export function ResponsiveReferenceList({
  hrefForValue,
  options = [],
  values,
}: {
  hrefForValue?: (value: string) => string | undefined;
  options?: readonly ReferenceOption[];
  values: string[];
}) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const measurementRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [visibleCount, setVisibleCount] = useState(Math.min(2, values.length));
  const measurementKey = values.join("\u0000");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const updateVisibleCount = () => {
      const availableWidth = container.clientWidth;
      const measuredCount = measurementKey ? measurementRefs.current.length : 0;
      const widths = measurementRefs.current
        .slice(0, measuredCount)
        .map((element) => element?.offsetWidth ?? 0);
      let usedWidth = 0;
      let nextVisibleCount = 0;
      for (let index = 0; index < widths.length; index += 1) {
        const gapWidth = nextVisibleCount > 0 ? CHIP_GAP_PX : 0;
        const overflowWidth =
          index < widths.length - 1 ? CHIP_GAP_PX + CHIP_OVERFLOW_WIDTH_PX : 0;
        if (
          usedWidth + gapWidth + widths[index] + overflowWidth >
          availableWidth
        ) {
          break;
        }
        usedWidth += gapWidth + widths[index];
        nextVisibleCount += 1;
      }
      setVisibleCount(nextVisibleCount);
    };
    updateVisibleCount();
    const observer = new ResizeObserver(updateVisibleCount);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measurementKey]);

  const optionById = new Map(options.map((option) => [option.id, option]));
  const visibleValues = values.slice(0, visibleCount);
  const hiddenValues = values.slice(visibleCount);
  return (
    <span
      className="relative flex w-full min-w-0 items-center gap-1 overflow-hidden"
      ref={containerRef}
    >
      {visibleValues.map((value) => {
        const option = optionById.get(value);
        return (
          <ReferenceBadge
            href={hrefForValue?.(value)}
            key={value}
            option={option}
            value={value}
          />
        );
      })}
      {hiddenValues.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex h-5 shrink-0 cursor-pointer items-center rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
              +{hiddenValues.length}
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
}: {
  href?: string;
  option?: ReferenceOption;
  value: string;
  measureRef?: (element: HTMLSpanElement | null) => void;
}) {
  const Icon = option?.icon ?? LinkIcon;
  const isSessionReference = Boolean(
    option?.ownerInitials && option.lastInteractionAt
  );
  const content = (
    <>
      {isSessionReference ? (
        <Avatar className="-ml-1 size-5 shrink-0 border border-current/15 ring-2 ring-background">
          <AvatarFallback className="bg-background/85 font-medium text-[9px] text-current">
            {option?.ownerInitials}
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
    "inline-flex min-w-0 shrink-0 items-center gap-1 border",
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

export function InlineInputCell({
  ariaLabel,
  initialValue,
  type,
}: {
  ariaLabel: string;
  initialValue: string;
  type: "date" | "number" | "text" | "time";
}) {
  const [value, setValue] = useState(initialValue);
  const [draft, setDraft] = useState(initialValue);
  const [editing, setEditing] = useState(Boolean(initialValue));
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelingRef = useRef(false);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);
  const commit = () => {
    if (draft === value) {
      return;
    }
    const previous = value;
    setValue(draft);
    setEditing(Boolean(draft));
    showSavedToast("Field updated", () => {
      setValue(previous);
      setDraft(previous);
      setEditing(Boolean(previous));
    });
  };
  if (!(editing || value)) {
    return (
      <button
        aria-label={ariaLabel}
        className="group w-full text-left"
        onClick={() => setEditing(true)}
        type="button"
      >
        <EmptyCustomValue />
      </button>
    );
  }
  return (
    <Input
      aria-label={ariaLabel}
      className={cn(
        "h-7 min-w-0 border-transparent bg-transparent px-1.5 text-sm shadow-none hover:bg-muted focus-visible:bg-background",
        (type === "number" || type === "time") && "font-mono"
      )}
      onBlur={() => {
        if (cancelingRef.current) {
          cancelingRef.current = false;
          return;
        }
        commit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          cancelingRef.current = true;
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      ref={inputRef}
      type={type}
      value={draft}
    />
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each custom-field type intentionally maps to its shared inline editor in one exhaustive switch.
export function CustomFieldCell({
  artifact,
  field,
}: {
  artifact: GenericArtifact;
  field: CustomFieldDefinition;
}) {
  const createdValue = artifact.creationValues?.[field.id];
  const optionIndex = artifact.title.length % (field.options?.length || 1);
  const option = field.options?.[optionIndex];
  const showEmptyState = Number(artifact.id.split("-").at(-1)) % 3 === 0;
  const initial = <Value,>(value: Value, emptyValue: Value): Value =>
    createdValue === undefined && showEmptyState ? emptyValue : value;
  const referenceValues = customFieldReferenceValues(field, artifact);
  switch (field.type) {
    case "Single-select":
      return (
        <EditableSingleSelectCell
          initialValue={initial(
            typeof createdValue === "string" ? createdValue : option,
            undefined
          )}
          optionColors={field.optionColors ?? []}
          options={field.options ?? []}
        />
      );
    case "Multi-select":
      return (
        <EditableMultiSelectCell
          initialValues={initial(
            Array.isArray(createdValue)
              ? [...createdValue]
              : (field.options ?? []).slice(0, 2),
            []
          )}
          optionColors={field.optionColors ?? []}
          options={field.options ?? []}
        />
      );
    case "Date":
      return (
        <InlineInputCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(
            typeof createdValue === "string"
              ? createdValue
              : `2026-07-${20 + (artifact.title.length % 9)}`,
            ""
          )}
          type="date"
        />
      );
    case "People":
      return (
        <EditableOwnerCell
          initialInitials={artifact.ownerInitials}
          initialOwner={artifact.owner}
        />
      );
    case "Reference":
      return (
        <EditableReferenceCell
          initialValues={initial(referenceValues.slice(0, 1), [])}
          multiple={false}
          source={field.sources?.[0]}
        />
      );
    case "Reference (multi)":
      return (
        <EditableReferenceCell
          initialValues={initial(referenceValues.slice(0, 3), [])}
          multiple
          source={field.sources?.[0]}
        />
      );
    case "Time":
      return (
        <InlineInputCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(
            typeof createdValue === "string" || typeof createdValue === "number"
              ? String(createdValue)
              : `02:${String((12 + artifact.title.length) % 60).padStart(2, "0")}`,
            ""
          )}
          type="time"
        />
      );
    case "Number":
      return (
        <InlineInputCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(
            typeof createdValue === "number" || typeof createdValue === "string"
              ? String(createdValue)
              : String(100 + artifact.title.length * 7),
            ""
          )}
          type="number"
        />
      );
    case "Text":
      return (
        <InlineInputCell
          ariaLabel={`Edit ${field.label}`}
          initialValue={initial(
            typeof createdValue === "string"
              ? createdValue
              : "Custom text value",
            ""
          )}
          type="text"
        />
      );
    default:
      return null;
  }
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
  customFields: CustomFieldDefinition[]
): string | number {
  const customField = customFields.find((field) => field.id === columnId);
  if (customField) {
    const values = customFieldValues(artifact, customField);
    return values.numericValue ?? values.textValues.join(" ");
  }
  switch (columnId) {
    case "collaborators":
      return artifact.collaborators.join(" ");
    case "status":
      return artifact.status;
    case "tags":
      return artifact.tags.join(" ");
    case "currentVersion":
      return Number(artifact.currentVersion.replace(/\D/g, ""));
    case "comments":
      return artifact.commentCount;
    case "owner":
      return artifact.owner;
    case "updated":
      return -artifact.updatedAgoMinutes;
    default:
      return artifact.title;
  }
}

export function StatusChip({ status }: { status: ArtifactStatus }) {
  return (
    <Chip className={cn("w-fit", statusChipClass[status])} variant="outline">
      {status}
    </Chip>
  );
}
