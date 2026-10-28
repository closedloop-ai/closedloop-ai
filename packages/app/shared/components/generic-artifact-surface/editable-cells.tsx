"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";

import { Chip } from "@repo/design-system/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { GridContextualAction } from "@repo/design-system/components/ui/grid-interaction-contract";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table-v2";
import { Input } from "@repo/design-system/components/ui/input";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { TableChoiceListCell } from "@repo/design-system/components/ui/table-cell-list-primitives";
import {
  TableIdentityCell,
  TablePeopleCell,
  type TablePerson,
  TablePersonCell,
  TableTextCell,
} from "@repo/design-system/components/ui/table-cell-primitives";
import { CheckIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ArtifactRow, tagChoice } from "./fixtures";
import {
  genericArtifactStatusCapability,
  genericArtifactStatusFacet,
  genericArtifactStatusFromRaw,
} from "./generic-artifact-status";

const inlineEditorRadioItemClassName = "pl-2 [&>span:first-child]:hidden";

export function EditableArtifactIdentityCell({
  artifact,
  onOpen,
  onTitleChange,
}: {
  artifact: ArtifactRow;
  onOpen: () => void;
  onTitleChange: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setDraft(artifact.title), [artifact.title]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const finish = (save: boolean) => {
    const title = draft.trim();
    if (save && title) {
      onTitleChange(title);
    } else {
      setDraft(artifact.title);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <Input
        aria-label={`Edit artifact name for ${artifact.slug}`}
        className="h-8 w-full"
        onBlur={() => finish(true)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            finish(true);
          } else if (event.key === "Escape") {
            finish(false);
          }
        }}
        ref={inputRef}
        value={draft}
      />
    );
  }

  return (
    <div className="group/lead flex h-8 w-full min-w-0 items-center">
      <button
        className="min-w-0 max-w-[calc(100%-4rem)] shrink-0 text-left hover:underline"
        onClick={onOpen}
        type="button"
      >
        <TableIdentityCell
          icon={artifact.icon}
          slug={artifact.slug}
          title={artifact.title}
        />
      </button>
      <GridContextualAction asChild legacyReveal="lead">
        <button
          aria-label={`Edit artifact name for ${artifact.slug}`}
          className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-grid-primary-editor=""
          onClick={() => setEditing(true)}
          type="button"
        >
          <PencilIcon className="size-3.5" />
        </button>
      </GridContextualAction>
      <span
        aria-hidden
        className="h-full min-w-8 flex-1 cursor-default"
        data-row-selection-surface=""
      />
    </div>
  );
}

export function EditableOwnerTableCell({
  onChange,
  options,
  owner,
}: {
  onChange: (owner: TablePerson) => void;
  options: readonly TablePerson[];
  owner: TablePerson | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit owner, currently ${owner?.name ?? "empty"}`}
          className="flex w-full max-w-full items-center rounded-md px-1 py-0.5 hover:bg-muted"
          data-grid-primary-editor=""
          type="button"
        >
          <TablePersonCell person={owner} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuLabel>Owner</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(name) => {
            const nextOwner = options.find((item) => item.name === name);
            if (nextOwner) {
              onChange(nextOwner);
            }
          }}
          value={owner?.name ?? ""}
        >
          {options.map((item) => (
            <DropdownMenuRadioItem
              className={inlineEditorRadioItemClassName}
              key={item.name}
              value={item.name}
            >
              <PersonAvatar
                avatarUrl={item.avatarUrl}
                className="size-5"
                decorative
                fallbackClassName="text-[9px]"
                initials={item.initials}
                name={item.name}
              />
              {item.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EditablePeopleTableCell({
  onChange,
  options,
  people,
}: {
  onChange: (people: TablePerson[]) => void;
  options: readonly TablePerson[];
  people: readonly TablePerson[];
}) {
  const [open, setOpen] = useState(false);
  const selectedNames = new Set(people.map((person) => person.name));
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit collaborators: ${people.map((person) => person.name).join(", ") || "none"}`}
          className="inline-flex min-h-8 max-w-full items-center rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted"
          data-grid-primary-editor=""
          type="button"
        >
          {people.length > 0 ? (
            <TablePeopleCell people={people} />
          ) : (
            <GridEmptyValue />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 overflow-hidden p-1">
        <div className="px-2 py-1.5 font-medium text-xs">Collaborators</div>
        {options.map((person) => {
          const selected = selectedNames.has(person.name);
          return (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted"
              key={person.name}
              onClick={() =>
                onChange(
                  selected
                    ? people.filter((item) => item.name !== person.name)
                    : [...people, person]
                )
              }
              type="button"
            >
              <TablePersonCell person={person} />
              {selected ? <CheckIcon className="ml-auto size-4" /> : null}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

export function EditableStatusTableCell({
  artifact,
  onChange,
}: {
  artifact: ArtifactRow;
  onChange: (status: ArtifactRow["status"]) => void;
}) {
  const facet = genericArtifactStatusFacet(artifact);
  const capability = genericArtifactStatusCapability(artifact);
  return (
    <span data-grid-primary-editor="">
      <ArtifactStatus
        ariaLabel={
          capability.editable
            ? `Edit status, currently ${artifactStatusLabel(facet)}`
            : undefined
        }
        capability={capability}
        onCommit={(commit) => {
          const status = genericArtifactStatusFromRaw(artifact.kind, commit.to);
          if (status !== null) {
            onChange(status);
          }
        }}
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={{ ...facet, artifactId: artifact.id }}
      />
    </span>
  );
}

export function EditableTagsTableCell({
  onChange,
  optionLabels,
  tags,
}: {
  onChange: (tags: string[]) => void;
  optionLabels: readonly string[];
  tags: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const matchingOptions = optionLabels.filter((label) =>
    label.toLowerCase().includes(normalizedQuery)
  );
  const exactMatch = optionLabels.some(
    (label) => label.toLowerCase() === normalizedQuery
  );
  const selectTag = (label: string) => {
    onChange(tags.includes(label) ? [...tags] : [...tags, label]);
    setQuery("");
  };
  const createTag = () => {
    const label = query.trim();
    if (label && !exactMatch) {
      onChange(tags.includes(label) ? [...tags] : [...tags, label]);
      setQuery("");
    }
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
      <PopoverTrigger asChild>
        <button
          aria-label={`Edit tags: ${tags.join(", ") || "none"}`}
          className="group w-full max-w-full rounded-md px-1 py-0.5 text-left hover:bg-muted"
          data-grid-primary-editor=""
          type="button"
        >
          {tags.length > 0 ? (
            <TableChoiceListCell choices={tags.map(tagChoice)} />
          ) : (
            <GridEmptyValue />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] overflow-hidden p-0">
        <div className="flex min-h-10 flex-wrap items-center gap-1 border-b px-2 py-1.5">
          {tags.map((tag) => (
            <Chip
              className={tagChoice(tag).className}
              key={tag}
              variant="outline"
            >
              <span className="max-w-32 truncate">{tag}</span>
              <button
                aria-label={`Remove ${tag}`}
                className="-mr-1 rounded-sm opacity-60 hover:opacity-100"
                onClick={() => onChange(tags.filter((value) => value !== tag))}
                type="button"
              >
                <XIcon className="size-3" />
              </button>
            </Chip>
          ))}
          <form
            className="min-w-24 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              const firstMatch = matchingOptions[0];
              if (firstMatch) {
                selectTag(firstMatch);
              } else {
                createTag();
              }
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
        <div className="max-h-64 overflow-y-auto p-1">
          {matchingOptions.map((label) => {
            const selected = tags.includes(label);
            return (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                key={label}
                onClick={() =>
                  onChange(
                    selected
                      ? tags.filter((value) => value !== label)
                      : [...tags, label]
                  )
                }
                type="button"
              >
                <span
                  aria-hidden
                  className={`size-3 shrink-0 rounded-sm ${
                    tagChoice(label)
                      .className?.split(" ")
                      .find((name) => name.startsWith("bg-")) ?? "bg-muted"
                  }`}
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
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
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function EditableTextTableCell({
  ariaLabel,
  onChange,
  value,
}: {
  ariaLabel: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const finish = (save: boolean) => {
    if (save) {
      onChange(draft.trim());
    } else {
      setDraft(value);
    }
    setEditing(false);
  };
  if (editing) {
    return (
      <Input
        aria-label={ariaLabel}
        className="h-7 min-w-0 border-transparent bg-transparent px-1.5 text-sm shadow-none hover:bg-muted focus-visible:bg-background"
        onBlur={() => finish(true)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            finish(true);
          } else if (event.key === "Escape") {
            finish(false);
          }
        }}
        ref={inputRef}
        value={draft}
      />
    );
  }
  return (
    <button
      aria-label={ariaLabel}
      className="group w-full rounded-md px-1 py-0.5 text-left hover:bg-muted"
      data-grid-primary-editor=""
      onClick={() => setEditing(true)}
      type="button"
    >
      {value ? (
        <TableTextCell value={value} />
      ) : (
        <span className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground text-sm opacity-0 transition-[opacity,background-color] group-hover:opacity-100 group-focus-visible:opacity-100">
          <PlusIcon className="size-3" />
          Add
        </span>
      )}
    </button>
  );
}
