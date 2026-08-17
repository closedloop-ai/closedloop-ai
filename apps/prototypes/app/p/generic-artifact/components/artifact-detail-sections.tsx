"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { cn } from "@repo/design-system/lib/utils";
import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  GitBranchIcon,
  HashIcon,
  Link2Icon,
  type LucideIcon,
  PencilIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { ArtifactStatus, type GenericArtifact } from "../mock";
import {
  type ArtifactActivityRecord,
  ArtifactActivityTrace,
  ArtifactVersionHistory,
  type ArtifactVersionRecord,
} from "./artifact-history";
import { ArtifactTypeIcons } from "./artifact-icons";
import {
  ArtifactPeopleStack,
  artifactPeople,
  personInitials,
} from "./artifact-people";

const FIRST_INTEGER_PATTERN = /\d+/;

export type {
  ArtifactActivityRecord,
  ArtifactVersionRecord,
} from "./artifact-history";

export type ArtifactDetailRowExtension = {
  editableValue?: string;
  id: string;
  label: string;
  value: ReactNode;
};
export type ArtifactLinkedRecord = {
  icon: LucideIcon;
  name: string;
  relationship: string;
  slug: string;
  type: string;
};
export type ArtifactDetailsPresentation = {
  activity?: readonly ArtifactActivityRecord[];
  additionalRows?: readonly ArtifactDetailRowExtension[];
  fields?: { currentVersion?: boolean };
  linkedArtifacts?: readonly ArtifactLinkedRecord[];
  sections?: {
    activity?: boolean;
    customFields?: boolean;
    linkedArtifacts?: boolean;
    versionHistory?: boolean;
  };
  versions?: readonly ArtifactVersionRecord[];
};

const statusVariant = {
  [ArtifactStatus.Active]: "success",
  [ArtifactStatus.Approved]: "success",
  [ArtifactStatus.Archived]: "muted",
  [ArtifactStatus.Backlog]: "muted",
  [ArtifactStatus.Canceled]: "muted",
  [ArtifactStatus.Completed]: "muted",
  [ArtifactStatus.Deprecated]: "muted",
  [ArtifactStatus.Done]: "success",
  [ArtifactStatus.Draft]: "muted",
  [ArtifactStatus.Failed]: "destructive",
  [ArtifactStatus.InProgress]: "warning",
  [ArtifactStatus.InReview]: "warning",
  [ArtifactStatus.NeedsYou]: "destructive",
  [ArtifactStatus.Published]: "success",
  [ArtifactStatus.ReadyForReview]: "warning",
  [ArtifactStatus.Running]: "success",
  [ArtifactStatus.Todo]: "muted",
  [ArtifactStatus.Triage]: "warning",
} as const satisfies Record<
  ArtifactStatus,
  "destructive" | "muted" | "success" | "warning"
>;

export function CommonArtifactDetails({
  artifact,
  initialVersion,
  onVersionChange,
  presentation,
}: {
  artifact: GenericArtifact;
  initialVersion?: string | null;
  onVersionChange?: (version: string) => void;
  presentation?: ArtifactDetailsPresentation;
}) {
  const [title, setTitle] = useState(artifact.title);
  const [summary, setSummary] = useState(artifact.summary);
  const [status, setStatus] = useState(artifact.status);
  const [owner, setOwner] = useState(artifact.owner);
  const [collaborators, setCollaborators] = useState([
    ...artifact.collaborators,
  ]);
  const [project, setProject] = useState(artifact.project ?? "No project");
  const [repository, setRepository] = useState(
    artifact.repository ?? "Not connected"
  );
  const [slug, setSlug] = useState(artifact.slug);
  const [currentVersion, setCurrentVersion] = useState(artifact.currentVersion);
  const [updated, setUpdated] = useState(artifact.updated);
  const [tags, setTags] = useState([...artifact.tags]);
  useEffect(() => setTitle(artifact.title), [artifact.title]);
  return (
    <div
      aria-label="Artifact details"
      className="min-h-0 flex-1 overflow-auto px-5 py-5"
      role="tabpanel"
    >
      <div className="mx-auto w-full max-w-6xl pb-10">
        <DetailTable>
          <DetailTableRow
            label="Artifact name"
            value={
              <InlineFieldTextEditor
                label="Artifact name"
                onChange={setTitle}
                value={title}
              />
            }
          />
          <DetailTableRow
            label="Artifact description"
            value={
              <InlineFieldTextEditor
                label="Artifact description"
                multiline
                onChange={setSummary}
                value={summary}
              />
            }
          />
          <DetailTableRow
            label="Status"
            value={<StatusEditor onChange={setStatus} value={status} />}
          />
          <DetailTableRow
            label="Owner"
            value={<OwnerEditor onChange={setOwner} value={owner} />}
          />
          <DetailTableRow
            label="Collaborators"
            value={
              <CollaboratorsEditor
                names={collaborators}
                onChange={setCollaborators}
              />
            }
          />
          <DetailTableRow
            label="Project"
            value={
              <InlineFieldTextEditor
                label="Project"
                onChange={setProject}
                value={project}
              />
            }
          />
          <DetailTableRow
            label="Repository"
            value={
              <InlineFieldTextEditor
                icon={GitBranchIcon}
                label="Repository"
                monospace
                onChange={setRepository}
                value={repository}
              />
            }
          />
          <DetailTableRow
            label="Slug"
            value={
              <InlineFieldTextEditor
                label="Slug"
                monospace
                onChange={setSlug}
                value={slug}
              />
            }
          />
          {presentation?.fields?.currentVersion === false ? null : (
            <DetailTableRow
              label="Current version"
              value={
                <InlineFieldTextEditor
                  label="Current version"
                  monospace
                  normalize={normalizeArtifactVersion}
                  onChange={setCurrentVersion}
                  value={currentVersion}
                />
              }
            />
          )}
          <DetailTableRow
            label="Updated"
            value={
              <InlineFieldTextEditor
                label="Updated"
                onChange={setUpdated}
                value={updated}
              />
            }
          />
          {presentation?.additionalRows?.map((row) => (
            <DetailTableRow
              key={row.id}
              label={row.label}
              value={
                row.editableValue === undefined ? (
                  row.value
                ) : (
                  <SelfManagedTextEditor
                    label={row.label}
                    value={row.editableValue}
                  />
                )
              }
            />
          ))}
          <DetailTableRow
            label="Tags"
            value={<DetailTagsEditor onChange={setTags} tags={tags} />}
          />
        </DetailTable>
        {presentation?.sections?.customFields === false ? null : (
          <ArtifactDetailSection title="Custom fields">
            <CustomFieldsTable />
          </ArtifactDetailSection>
        )}
        {presentation?.sections?.linkedArtifacts === false ? null : (
          <ArtifactDetailSection title="Linked artifacts">
            <LinkedArtifactsTable
              artifact={artifact}
              records={presentation?.linkedArtifacts}
            />
          </ArtifactDetailSection>
        )}
        {presentation?.sections?.versionHistory === false ? null : (
          <ArtifactDetailSection
            description="Select a version to inspect it, compare it with the current version, or restore it."
            title="Version history"
          >
            <ArtifactVersionHistory
              artifact={artifact}
              initialVersion={initialVersion}
              onVersionChange={onVersionChange}
              records={presentation?.versions}
            />
          </ArtifactDetailSection>
        )}
        {presentation?.sections?.activity === false ? null : (
          <ArtifactDetailSection title="Activity">
            <ArtifactActivityTrace
              artifact={artifact}
              records={presentation?.activity}
            />
          </ArtifactDetailSection>
        )}
      </div>
    </div>
  );
}

function InlineFieldTextEditor({
  icon: Icon,
  label,
  multiline = false,
  monospace = false,
  normalize = (nextValue) => nextValue.trim(),
  onChange,
  value,
}: {
  icon?: LucideIcon;
  label: string;
  multiline?: boolean;
  monospace?: boolean;
  normalize?: (value: string) => string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const save = () => {
    const normalizedDraft = normalize(draft);
    if (normalizedDraft) {
      onChange(normalizedDraft);
      setDraft(normalizedDraft);
    } else {
      setDraft(value);
    }
    setOpen(false);
  };
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit ${label.toLowerCase()}`}
          className={cn(
            "group flex max-w-full items-start gap-2 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            multiline && "leading-5",
            monospace && "font-mono"
          )}
          type="button"
        >
          {Icon ? (
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : null}
          <span className={cn("min-w-0", !multiline && "truncate")}>
            {value}
          </span>
          <PencilIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("p-3", multiline ? "w-[32rem]" : "w-[26rem]")}
      >
        <div className="mb-2 font-medium text-sm">{label}</div>
        {multiline ? (
          <Textarea
            aria-label={label}
            autoFocus
            className="min-h-24 resize-none text-sm"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(value);
                setOpen(false);
              }
            }}
            value={draft}
          />
        ) : (
          <Input
            aria-label={label}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                save();
              } else if (event.key === "Escape") {
                setDraft(value);
                setOpen(false);
              }
            }}
            value={draft}
          />
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button
            onClick={() => {
              setDraft(value);
              setOpen(false);
            }}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button onClick={save} size="sm">
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function normalizeArtifactVersion(value: string) {
  const parsedVersion = Number.parseInt(
    value.match(FIRST_INTEGER_PATTERN)?.[0] ?? "",
    10
  );
  return Number.isFinite(parsedVersion) && parsedVersion > 0
    ? String(parsedVersion)
    : "";
}

function SelfManagedTextEditor({
  label,
  value: initialValue,
}: {
  label: string;
  value: string;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <InlineFieldTextEditor label={label} onChange={setValue} value={value} />
  );
}
function StatusEditor({
  onChange,
  value,
}: {
  onChange: (status: ArtifactStatus) => void;
  value: ArtifactStatus;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button aria-label={`Edit status, currently ${value}`} type="button">
          <Chip interactive variant={statusVariant[value]}>
            {value}
          </Chip>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {Object.values(ArtifactStatus).map((status) => (
          <DropdownMenuItem key={status} onSelect={() => onChange(status)}>
            {status}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function OwnerEditor({
  onChange,
  value,
}: {
  onChange: (owner: string) => void;
  value: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit owner, currently ${value}`}
          className="group flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-muted"
          type="button"
        >
          <Avatar className="size-7">
            <AvatarFallback className="text-[10px]">
              {personInitials(value)}
            </AvatarFallback>
          </Avatar>
          <span>{value}</span>
          <PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {artifactPeople.map((person) => (
          <DropdownMenuItem key={person} onSelect={() => onChange(person)}>
            {person}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CollaboratorsEditor({
  emptyLabel = "No collaborators",
  names,
  onChange,
  showEditIndicator = true,
}: {
  emptyLabel?: string;
  names: readonly string[];
  onChange: (names: string[]) => void;
  showEditIndicator?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (person: string) =>
    onChange(
      names.includes(person)
        ? names.filter((name) => name !== person)
        : [...names, person]
    );
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit collaborators: ${names.join(", ") || "none"}`}
          className="group inline-flex min-h-8 max-w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted"
          type="button"
        >
          {names.length > 0 ? (
            <ArtifactPeopleStack names={names} />
          ) : (
            <span className="text-muted-foreground">{emptyLabel}</span>
          )}
          {showEditIndicator ? (
            <PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 overflow-hidden p-1">
        <div className="px-2 py-1.5 font-medium text-xs">Collaborators</div>
        {artifactPeople.map((person) => (
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
            key={person}
            onClick={() => toggle(person)}
            type="button"
          >
            <Avatar className="size-6">
              <AvatarFallback className="text-[10px]">
                {personInitials(person)}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate">{person}</span>
            {names.includes(person) ? <CheckIcon className="size-4" /> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function ArtifactDetailSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className="mt-8 w-full">
      <ArtifactSectionHeading description={description} title={title} />
      {children}
    </section>
  );
}
export function ArtifactSectionHeading({
  className,
  count,
  description,
  title,
  trailing,
}: {
  className?: string;
  count?: ReactNode;
  description?: string;
  title: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className={cn("mb-3 flex items-baseline gap-2", className)}>
      <h2 className="font-semibold text-lg">{title}</h2>
      {description ? (
        <p className="text-muted-foreground text-xs">{description}</p>
      ) : null}
      {count == null ? null : (
        <span className="text-muted-foreground text-xs">{count}</span>
      )}
      {trailing ? <span className="ml-auto">{trailing}</span> : null}
    </div>
  );
}
function DetailTable({ children }: { children: ReactNode }) {
  return <div className="w-full border-y">{children}</div>;
}
function DetailTableRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid min-h-12 grid-cols-[7.5rem_minmax(0,1fr)] items-center border-b px-1 text-sm last:border-b-0 md:grid-cols-[12rem_minmax(0,1fr)]">
      <div className="px-3 font-medium text-muted-foreground">{label}</div>
      <div className="min-w-0 border-l px-4 py-2">{value}</div>
    </div>
  );
}

function CustomFieldsTable() {
  const [reviewers, setReviewers] = useState<string[]>([
    "Andrew Eye",
    "Jordan Lee",
  ]);
  return (
    <DetailTable>
      <DetailTableRow label="Custom field" value={<DetailSelectEditor />} />
      <DetailTableRow
        label="Custom multi-select"
        value={
          <MultiValueEditor
            options={["Research", "Design", "Implementation", "Validation"]}
          />
        }
      />
      <DetailTableRow
        label="Custom date"
        value={
          <PrimitiveFieldEditor
            icon={CalendarIcon}
            initialValue="2026-08-21"
            inputType="date"
            label="Custom date"
          />
        }
      />
      <DetailTableRow
        label="Custom people"
        value={
          <CollaboratorsEditor names={reviewers} onChange={setReviewers} />
        }
      />
      <DetailTableRow
        label="Custom reference"
        value={<DetailReferenceEditor />}
      />
      <DetailTableRow
        label="Custom reference (multi)"
        value={
          <MultiValueEditor
            icon={Link2Icon}
            options={[
              "PRD-595 Generic artifact experience",
              "FEA-2481 Unified artifact experience",
              "BR-2048 Generic artifacts prototype",
            ]}
          />
        }
      />
      <DetailTableRow
        label="Custom time"
        value={
          <PrimitiveFieldEditor
            icon={ClockIcon}
            initialValue="01:30"
            inputType="time"
            label="Custom time"
          />
        }
      />
      <DetailTableRow
        label="Custom text"
        value={
          <PrimitiveFieldEditor
            initialValue="Shared artifact shell"
            label="Custom text"
          />
        }
      />
      <DetailTableRow
        label="Custom number"
        value={
          <PrimitiveFieldEditor
            icon={HashIcon}
            initialValue="42"
            inputType="number"
            label="Custom number"
          />
        }
      />
    </DetailTable>
  );
}
function PrimitiveFieldEditor({
  icon: Icon,
  initialValue,
  inputType = "text",
  label,
}: {
  icon?: LucideIcon;
  initialValue: string;
  inputType?: "date" | "number" | "text" | "time";
  label: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [draft, setDraft] = useState(initialValue);
  const [open, setOpen] = useState(false);
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit ${label.toLowerCase()}, currently ${value}`}
          className="group inline-flex max-w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm hover:bg-muted"
          type="button"
        >
          {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
          <span className="truncate">{value}</span>
          <PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="mb-2 font-medium text-sm">{label}</div>
        <Input
          aria-label={label}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          type={inputType}
          value={draft}
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button
            onClick={() => {
              setDraft(value);
              setOpen(false);
            }}
            size="sm"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              setValue(draft);
              setOpen(false);
            }}
            size="sm"
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function MultiValueEditor({
  icon: Icon = UsersIcon,
  options,
}: {
  icon?: LucideIcon;
  options: readonly string[];
}) {
  const [selected, setSelected] = useState<string[]>(options.slice(0, 2));
  const toggle = (option: string) =>
    setSelected((current) =>
      current.includes(option)
        ? current.filter((value) => value !== option)
        : [...current, option]
    );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit values: ${selected.join(", ")}`}
          className="group flex max-w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted"
          type="button"
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 gap-1 overflow-hidden">
            {selected.map((value) => (
              <Chip
                className="max-w-48 truncate"
                key={value}
                size="sm"
                variant="muted"
              >
                {value}
              </Chip>
            ))}
          </span>
          <PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1">
        {options.map((option) => (
          <button
            className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
            key={option}
            onClick={() => toggle(option)}
            type="button"
          >
            <span className="truncate">{option}</span>
            {selected.includes(option) ? (
              <CheckIcon className="size-4" />
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function LinkedArtifactsTable({
  artifact,
  records,
}: {
  artifact: GenericArtifact;
  records?: readonly ArtifactLinkedRecord[];
}) {
  const linked = records ?? [
    {
      icon: ArtifactTypeIcons.Document,
      slug: "PRD-595",
      name: "Generic artifact and project experience",
      type: "Document",
      relationship: "Defines",
    },
    {
      icon: ArtifactTypeIcons.Branch,
      slug: "BR-2048",
      name: "prototype/generic-artifacts-web-master",
      type: "Branch",
      relationship: "Implemented by",
    },
    {
      icon: ArtifactTypeIcons.Session,
      slug: "SES-7B91",
      name: "Prototype generic artifact shells",
      type: "Session",
      relationship: `Updated ${artifact.slug}`,
    },
  ];
  return (
    <div className="w-full border-y">
      <div className="grid grid-cols-[minmax(0,1.6fr)_10rem_12rem] border-b bg-muted/30 px-4 py-2 text-muted-foreground text-xs">
        <span>Artifact</span>
        <span>Type</span>
        <span>Relationship</span>
      </div>
      {linked.map((item) => {
        const Icon = item.icon;
        return (
          <button
            className="grid min-h-12 w-full grid-cols-[minmax(0,1.6fr)_10rem_12rem] items-center border-b px-4 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/40"
            key={item.slug}
            onClick={() => toast.success(`Opened ${item.slug}`)}
            type="button"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-mono text-muted-foreground text-xs">
                {item.slug}
              </span>
              <span className="truncate font-medium">{item.name}</span>
            </span>
            <span className="text-muted-foreground">{item.type}</span>
            <span className="text-muted-foreground">{item.relationship}</span>
          </button>
        );
      })}
    </div>
  );
}
function TagList({ tags }: { tags: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <Chip key={tag} size="sm" variant="muted">
          {tag}
        </Chip>
      ))}
    </div>
  );
}
function DetailSelectEditor() {
  const [value, setValue] = useState("Example value");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit custom field, currently ${value}`}
          className="group rounded-md p-0.5 transition-colors hover:bg-muted"
          type="button"
        >
          <Chip interactive variant="info">
            {value}
          </Chip>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {["Example value", "In progress", "Ready", "Blocked"].map((option) => (
          <DropdownMenuItem key={option} onSelect={() => setValue(option)}>
            {option}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function DetailReferenceEditor() {
  const [value, setValue] = useState("PRD-595 Generic artifact experience");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit custom reference, currently ${value}`}
          className="group inline-flex max-w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted"
          type="button"
        >
          <Link2Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{value}</span>
          <PencilIcon className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        {[
          "PRD-595 Generic artifact experience",
          "FEA-2481 Unified artifact experience",
          "BR-2048 prototype/generic-artifacts-web-master",
        ].map((option) => (
          <DropdownMenuItem key={option} onSelect={() => setValue(option)}>
            <Link2Icon />
            {option}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function DetailTagsEditor({
  onChange,
  tags,
}: {
  onChange: (tags: string[]) => void;
  tags: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const options = [
    "Principles",
    "Product",
    "Design system",
    "Research",
    "Governance",
    "Prototype",
  ];
  const filtered = options.filter((option) =>
    option.toLowerCase().includes(query.toLowerCase())
  );
  const toggle = (tag: string) =>
    onChange(
      tags.includes(tag)
        ? tags.filter((existing) => existing !== tag)
        : [...tags, tag]
    );
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit tags: ${tags.join(", ")}`}
          className="group flex min-h-7 max-w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted"
          type="button"
        >
          <TagList tags={tags} />
          <PencilIcon className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 overflow-hidden p-0">
        <div className="border-b p-2">
          <Input
            aria-label="Search or add tags"
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search or add tags…"
            value={query}
          />
        </div>
        <div className="max-h-60 overflow-auto p-1">
          {filtered.map((option) => (
            <button
              className="flex w-full items-center justify-between rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
              key={option}
              onClick={() => toggle(option)}
              type="button"
            >
              <Chip variant="muted">{option}</Chip>
              <span className="text-muted-foreground">
                {tags.includes(option) ? "Added" : ""}
              </span>
            </button>
          ))}
          {query.trim() && !options.includes(query.trim()) ? (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
              onClick={() => {
                onChange([...tags, query.trim()]);
                setQuery("");
              }}
              type="button"
            >
              <PlusIcon className="size-4" />
              Create “{query.trim()}”
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
