"use client";

import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@repo/design-system/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { Switch } from "@repo/design-system/components/ui/switch";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  BoldIcon,
  CalendarIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDotDashedIcon,
  Code2Icon,
  ExpandIcon,
  FolderIcon,
  GitBranchIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  MoreHorizontalIcon,
  PaperclipIcon,
  QuoteIcon,
  ShrinkIcon,
  StrikethroughIcon,
  TagIcon,
  UnderlineIcon,
  UserRoundIcon,
  UsersRoundIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import {
  genericArtifactStatusDefaultForRoot,
  genericArtifactStatusOptions,
} from "../../generic-artifact-status";
import type { ArtifactStatus, GenericArtifact } from "../fixtures";
import {
  type ArtifactCreationConfig,
  type ArtifactCreationField,
  type ArtifactCreationSubmissionOptions,
  type ArtifactCreationValues,
  artifactKindForCreation,
  genericArtifactDefaultStatus,
} from "./artifact-creation";
import { ArtifactCreationStatusPicker } from "./artifact-creation-status-picker";
import { ArtifactTypeIcons, GenericArtifactIcon } from "./artifact-icons";
import { EDITABLE_OWNERS } from "./artifact-list-owners";

type CreationValue = string | number | readonly string[] | null;

export function AddArtifactDialog({
  artifacts,
  config,
  customFields,
  initialStatus,
  onCreate,
  onOpenChange,
  open,
}: {
  artifacts: readonly GenericArtifact[];
  config: ArtifactCreationConfig;
  customFields: readonly CustomFieldDefinition[];
  initialStatus?: ArtifactStatus | null;
  onCreate: (
    values: ArtifactCreationValues,
    options?: ArtifactCreationSubmissionOptions
  ) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [owner, setOwner] = useState("Ottilie Eastwick");
  const [status, setStatus] = useState<ArtifactStatus>(() =>
    genericArtifactDefaultStatus(config.kind)
  );
  const [project, setProject] = useState(
    config.defaultProject ?? "Artifact foundations"
  );
  const [repository, setRepository] = useState("closedloop-ai");
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [linkedArtifacts, setLinkedArtifacts] = useState<string[]>([]);
  const [customValues, setCustomValues] = useState<
    Record<string, CreationValue>
  >({});
  const [expanded, setExpanded] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const attachmentRef = useRef<HTMLInputElement>(null);
  const effectiveKind = artifactKindForCreation(config, customValues);
  const statusOptions = genericArtifactStatusOptions(effectiveKind);
  const creationFields = [
    ...(config.fields ?? []),
    ...customFields.map((field) =>
      customFieldToCreationField(field, artifacts)
    ),
  ];
  const chipFields = creationFields.filter(
    (field) => field.type === "select" || field.type === "multi-select"
  );
  const additionalFields = creationFields.filter(
    (field) => field.type !== "select" && field.type !== "multi-select"
  );
  const requiredFieldsComplete = creationFields
    .filter((field) => field.required)
    .every((field) => hasCreationValue(customValues[field.id]));
  const canCreate = Boolean(title.trim() && requiredFieldsComplete);
  const Icon =
    config.noun === "artifact"
      ? GenericArtifactIcon
      : ArtifactTypeIcons[config.kind];

  useEffect(() => {
    if (open) {
      setStatus(
        initialStatus && statusOptions.includes(initialStatus)
          ? initialStatus
          : genericArtifactDefaultStatus(effectiveKind)
      );
    }
  }, [effectiveKind, initialStatus, open, statusOptions]);

  const reset = () => {
    setTitle("");
    setSummary("");
    setOwner("Ottilie Eastwick");
    setStatus(genericArtifactDefaultStatus(config.kind));
    setProject("Artifact foundations");
    setRepository("closedloop-ai");
    setCollaborators([]);
    setTags([]);
    setLinkedArtifacts([]);
    setCustomValues({});
    setExpanded(false);
    setCreateMore(false);
    setAttachments([]);
  };

  const values = (): ArtifactCreationValues => ({
    attachments,
    collaborators,
    customValues,
    linkedArtifacts,
    owner,
    project: project || null,
    repository: config.includeRepository ? repository || null : null,
    status,
    summary: summary.trim(),
    tags,
    title: title.trim(),
  });

  const create = () => {
    if (!canCreate) {
      return;
    }
    onCreate(values(), { openAfterCreate: !createMore });
    if (createMore) {
      const retainedProject = project;
      const retainedRepository = repository;
      reset();
      setProject(retainedProject);
      setRepository(retainedRepository);
      setCreateMore(true);
      return;
    }
    reset();
    onOpenChange(false);
  };

  const saveDraft = () => {
    onCreate(
      {
        ...values(),
        status:
          genericArtifactStatusDefaultForRoot(
            effectiveKind,
            ARTIFACT_STATUS_ROOT.Todo
          ) ?? genericArtifactDefaultStatus(effectiveKind),
        tags: tags.includes("Draft") ? tags : [...tags, "Draft"],
        title: title.trim() || `Untitled ${config.noun}`,
      },
      { draft: true, openAfterCreate: false }
    );
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
      <DialogContent
        aria-describedby="artifact-creator-description"
        className={cn(
          "flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden rounded-2xl p-0 transition-[width,height,max-width] duration-200",
          expanded
            ? "h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]"
            : "min-h-[520px] sm:max-w-4xl"
        )}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Create {config.noun}</DialogTitle>
        <DialogDescription
          className="sr-only"
          id="artifact-creator-description"
        >
          {config.description}
        </DialogDescription>

        <header className="flex h-14 shrink-0 items-center gap-2 px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2 font-medium text-sm">
            <span className="flex size-8 items-center justify-center rounded-full border bg-muted/40">
              <Icon className="size-4" />
            </span>
            <span className="truncate">{capitalize(config.noun)}</span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate text-muted-foreground">
              New {config.noun}
            </span>
          </div>
          <Button onClick={saveDraft} size="sm" type="button" variant="outline">
            Save as draft
          </Button>
          <Button
            aria-label={expanded ? "Collapse creator" : "Expand creator"}
            onClick={() => setExpanded((current) => !current)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {expanded ? <ShrinkIcon /> : <ExpandIcon />}
          </Button>
          <Button
            aria-label="Close creator"
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </header>

        <div
          className={cn(
            "min-h-0 flex-1 px-6 pt-3 pb-4 sm:px-8",
            expanded ? "flex flex-col overflow-hidden" : "overflow-y-auto"
          )}
        >
          <input
            aria-label={`${capitalize(config.noun)} title`}
            autoFocus
            className="w-full bg-transparent font-semibold text-2xl outline-none placeholder:text-muted-foreground/60"
            onChange={(event) => setTitle(event.target.value)}
            placeholder={`${capitalize(config.noun)} title`}
            value={title}
          />
          <div
            className={cn(
              "group relative mt-4",
              expanded ? "flex min-h-0 flex-1 flex-col" : "min-h-44"
            )}
          >
            <FormattingToolbar onFormat={insertFormatting} />
            <textarea
              aria-label={`${capitalize(config.noun)} description`}
              className={cn(
                "w-full resize-none bg-transparent text-base leading-7 outline-none placeholder:text-muted-foreground/60",
                expanded ? "min-h-0 flex-1" : "min-h-40"
              )}
              onChange={(event) => setSummary(event.target.value)}
              placeholder={`Add ${config.noun} description…`}
              ref={descriptionRef}
              value={summary}
            />
          </div>

          {attachments.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {attachments.map((attachment) => (
                <span
                  className="rounded-full border bg-muted/40 px-3 py-1 text-xs"
                  key={attachment}
                >
                  {attachment}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <footer className="shrink-0 px-5 pb-5 sm:px-8">
          <div className="flex flex-wrap items-center gap-2">
            <ArtifactCreationStatusPicker
              kind={effectiveKind}
              onChange={setStatus}
              status={status}
            />
            {chipFields.map((field) => (
              <CreationPicker
                icon={fieldIcon(field)}
                key={field.id}
                label={creationFieldLabel(field, customValues[field.id])}
                multiple={field.type === "multi-select"}
                onChange={(next) =>
                  setCustomValues((current) => ({
                    ...current,
                    [field.id]: next,
                  }))
                }
                options={field.options ?? []}
                required={field.required}
                searchLabel={`Set ${field.label.toLowerCase()}…`}
                value={customValues[field.id]}
              />
            ))}
            <CreationPicker
              icon={<UserRoundIcon />}
              label={owner}
              onChange={(next) => setOwner(String(next))}
              options={EDITABLE_OWNERS.map((person) => person.name)}
              searchLabel="Assign owner…"
              value={owner}
            />
            <CreationPicker
              icon={<FolderIcon />}
              label={project || "Project"}
              onChange={(next) => setProject(String(next))}
              options={[
                "Artifact foundations",
                "Ottilie August Strategic Projects",
                "Platform Engineering",
              ]}
              searchLabel="Set project…"
              value={project}
            />
            <CreationPicker
              icon={<TagIcon />}
              label={tags.length ? tags.join(", ") : "Tags"}
              multiple
              onChange={(next) => setTags(next as string[])}
              options={[
                "Foundations",
                "Product",
                "Prototype",
                "Research",
                "UX",
              ]}
              searchLabel="Add tags…"
              value={tags}
            />
            <CreationPicker
              icon={<UsersRoundIcon />}
              label={
                collaborators.length
                  ? `${collaborators.length} collaborators`
                  : "Collaborators"
              }
              multiple
              onChange={(next) => setCollaborators(next as string[])}
              options={EDITABLE_OWNERS.map((person) => person.name).filter(
                (name) => name !== owner
              )}
              searchLabel="Add collaborators…"
              value={collaborators}
            />
            <AdditionalFieldsPopover
              additionalFields={additionalFields}
              artifacts={artifacts}
              config={config}
              customValues={customValues}
              linkedArtifacts={linkedArtifacts}
              onCustomValueChange={(fieldId, value) =>
                setCustomValues((current) => ({ ...current, [fieldId]: value }))
              }
              onLinkedArtifactsChange={setLinkedArtifacts}
              onRepositoryChange={setRepository}
              repository={repository}
            />
          </div>

          <div className="mt-5 flex items-center gap-3">
            <input
              className="hidden"
              multiple
              onChange={(event) =>
                setAttachments(
                  Array.from(event.target.files ?? []).map((file) => file.name)
                )
              }
              ref={attachmentRef}
              type="file"
            />
            <Button
              aria-label="Attach files"
              className="rounded-full"
              onClick={() => attachmentRef.current?.click()}
              size="icon"
              type="button"
              variant="outline"
            >
              <PaperclipIcon />
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Switch
                checked={createMore}
                id="create-more-artifacts"
                onCheckedChange={setCreateMore}
              />
              <label
                className="text-muted-foreground text-sm"
                htmlFor="create-more-artifacts"
              >
                Create more
              </label>
              <Button disabled={!canCreate} onClick={create} type="button">
                Create {config.noun}
              </Button>
            </div>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );

  function insertFormatting(prefix: string, suffix = prefix) {
    const target = descriptionRef.current;
    if (!target) {
      return;
    }
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const next = `${summary.slice(0, start)}${prefix}${summary.slice(start, end)}${suffix}${summary.slice(end)}`;
    setSummary(next);
    requestAnimationFrame(() => {
      target.focus();
      target.setSelectionRange(start + prefix.length, end + prefix.length);
    });
  }
}

function CreationPicker({
  icon,
  label,
  multiple = false,
  onChange,
  options,
  required = false,
  searchLabel,
  value,
}: {
  icon: ReactNode;
  label: string;
  multiple?: boolean;
  onChange: (value: string | string[]) => void;
  options: readonly string[];
  required?: boolean;
  searchLabel: string;
  value: CreationValue | undefined;
}) {
  let selected: readonly string[] = [];
  if (Array.isArray(value)) {
    selected = value;
  } else if (typeof value === "string") {
    selected = [value];
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`${searchLabel}${required ? " Required" : ""}`}
          className={cn(
            "h-8 max-w-56 rounded-full px-3 font-normal",
            required &&
              selected.length === 0 &&
              "border-destructive/40 text-destructive"
          )}
          type="button"
          variant="outline"
        >
          {icon}
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder={searchLabel} />
          <CommandList>
            <CommandEmpty>No options found.</CommandEmpty>
            {options.map((option, index) => {
              const active = selected.includes(option);
              return (
                <CommandItem
                  key={option}
                  onSelect={() => {
                    if (!multiple) {
                      onChange(option);
                      return;
                    }
                    onChange(
                      active
                        ? selected.filter((item) => item !== option)
                        : [...selected, option]
                    );
                  }}
                  value={option}
                >
                  <span className="flex size-5 items-center justify-center rounded-full border text-[10px] text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option}</span>
                  {active ? <CheckIcon className="text-primary" /> : null}
                </CommandItem>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AdditionalFieldsPopover({
  additionalFields,
  artifacts,
  config,
  customValues,
  linkedArtifacts,
  onCustomValueChange,
  onLinkedArtifactsChange,
  onRepositoryChange,
  repository,
}: {
  additionalFields: readonly ArtifactCreationField[];
  artifacts: readonly GenericArtifact[];
  config: ArtifactCreationConfig;
  customValues: Readonly<Record<string, CreationValue>>;
  linkedArtifacts: string[];
  onCustomValueChange: (fieldId: string, value: CreationValue) => void;
  onLinkedArtifactsChange: (values: string[]) => void;
  onRepositoryChange: (value: string) => void;
  repository: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="More creation fields"
          className="size-8 rounded-full"
          size="icon"
          type="button"
          variant="outline"
        >
          <MoreHorizontalIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-4 p-4">
        <div>
          <p className="font-medium text-sm">Additional fields</p>
          <p className="text-muted-foreground text-xs">
            Fields not shown as quick properties remain available here.
          </p>
        </div>
        {config.includeRepository ? (
          <label className="block space-y-1.5" htmlFor="creation-repository">
            <span className="flex items-center gap-2 text-sm">
              <GitBranchIcon className="size-4 text-muted-foreground" />{" "}
              Repository
            </span>
            <Input
              id="creation-repository"
              onChange={(event) => onRepositoryChange(event.target.value)}
              value={repository}
            />
          </label>
        ) : null}
        <CreationPicker
          icon={<LinkIcon />}
          label={
            linkedArtifacts.length
              ? `${linkedArtifacts.length} linked artifacts`
              : "Linked artifacts"
          }
          multiple
          onChange={(next) => onLinkedArtifactsChange(next as string[])}
          options={artifacts.map(
            (artifact) => `${artifact.slug} ${artifact.title}`
          )}
          searchLabel="Link artifacts…"
          value={linkedArtifacts}
        />
        {additionalFields.map((field) => (
          <label
            className="block space-y-1.5"
            htmlFor={`creation-${field.id}`}
            key={field.id}
          >
            <span className="flex items-center gap-2 text-sm">
              {fieldIcon(field)} {field.label}
              {field.required ? " *" : ""}
            </span>
            {field.type === "textarea" ? (
              <Textarea
                className="max-h-48 min-h-24 resize-none text-sm"
                id={`creation-${field.id}`}
                onChange={(event) =>
                  onCustomValueChange(field.id, event.target.value)
                }
                placeholder={field.placeholder}
                value={stringCreationValue(customValues[field.id])}
              />
            ) : (
              <Input
                id={`creation-${field.id}`}
                onChange={(event) =>
                  onCustomValueChange(
                    field.id,
                    field.type === "number"
                      ? Number(event.target.value)
                      : event.target.value
                  )
                }
                placeholder={field.placeholder}
                type={creationInputType(field)}
                value={inputCreationValue(customValues[field.id])}
              />
            )}
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function stringCreationValue(value: CreationValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function inputCreationValue(value: CreationValue | undefined): string | number {
  return typeof value === "number" || typeof value === "string" ? value : "";
}

function FormattingToolbar({
  onFormat,
}: {
  onFormat: (prefix: string, suffix?: string) => void;
}) {
  const actions = [
    { icon: BoldIcon, label: "Bold", prefix: "**" },
    { icon: ItalicIcon, label: "Italic", prefix: "_" },
    { icon: StrikethroughIcon, label: "Strikethrough", prefix: "~~" },
    { icon: UnderlineIcon, label: "Underline", prefix: "<u>", suffix: "</u>" },
    { icon: LinkIcon, label: "Link", prefix: "[", suffix: "](url)" },
    { icon: QuoteIcon, label: "Quote", prefix: "> ", suffix: "" },
    { icon: Code2Icon, label: "Code", prefix: "`" },
    { icon: ListIcon, label: "List", prefix: "- ", suffix: "" },
  ] as const;
  return (
    <div className="mb-3 flex w-fit items-center rounded-lg border bg-popover p-1 opacity-0 shadow-sm transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
      {actions.map((action) => (
        <Button
          aria-label={action.label}
          key={action.label}
          onMouseDown={(event) => {
            event.preventDefault();
            onFormat(
              action.prefix,
              "suffix" in action ? action.suffix : undefined
            );
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <action.icon />
        </Button>
      ))}
    </div>
  );
}

function fieldIcon(field: ArtifactCreationField): ReactNode {
  if (field.type === "date") {
    return <CalendarIcon />;
  }
  if (field.id.includes("owner") || field.id.includes("assignee")) {
    return <UserRoundIcon />;
  }
  if (field.id.includes("tag") || field.id.includes("label")) {
    return <TagIcon />;
  }
  return <CircleDotDashedIcon />;
}

function creationFieldLabel(
  field: ArtifactCreationField,
  value: CreationValue | undefined
): string {
  if (Array.isArray(value)) {
    return value.length ? `${field.label}: ${value.length}` : field.label;
  }
  return hasCreationValue(value) ? String(value) : field.label;
}

function hasCreationValue(value: CreationValue | undefined): boolean {
  return Array.isArray(value)
    ? value.length > 0
    : Boolean(String(value ?? "").trim());
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

function creationInputType(
  field: ArtifactCreationField
): "date" | "number" | "text" {
  if (field.type === "date") {
    return "date";
  }
  if (field.type === "number") {
    return "number";
  }
  return "text";
}

function customFieldToCreationField(
  field: CustomFieldDefinition,
  artifacts: readonly GenericArtifact[]
): ArtifactCreationField {
  return {
    description: field.description,
    id: field.id,
    label: field.label,
    options:
      field.options ??
      (field.type.startsWith("Reference")
        ? artifacts.map((artifact) => artifact.slug)
        : undefined),
    type: customFieldCreationType(field),
  };
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
