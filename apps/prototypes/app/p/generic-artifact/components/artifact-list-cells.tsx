"use client";

import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { FavoriteButton } from "@repo/design-system/components/ui/favorite-button";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { cn } from "@repo/design-system/lib/utils";
import { MessageSquareIcon, PencilIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ArtifactStatus, type GenericArtifact } from "../mock";
import {
  CustomFieldCell,
  EditableOwnerCell,
  EditableTagsCell,
  StatusChip,
  showSavedToast,
} from "./artifact-list-custom-cells";
import {
  type ArtifactListColumnExtension,
  inlineEditorRadioItemClassName,
  kindIcon,
  PAGE_SIZES,
} from "./artifact-list-model";
import type { CustomFieldDefinition } from "./custom-field-dialog";
import type { GridTableColumn } from "./experimental/grid-table";
import { TablePagination } from "./experimental/table-pagination";
import { CollaboratorsEditor } from "./generic-artifact-detail-shell";

export function GenericArtifactLead({
  artifact,
}: {
  artifact: GenericArtifact;
}) {
  const Icon = kindIcon[artifact.kind];

  return (
    <span className="flex min-w-0 items-center gap-2 font-medium text-sm">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 font-normal text-muted-foreground">
        {artifact.slug}
      </span>
      <span className="truncate">{artifact.title}</span>
    </span>
  );
}

export function EditableArtifactLead({
  artifact,
  onCommit,
  onOpenArtifact,
  openHref,
}: {
  artifact: GenericArtifact;
  onCommit: (
    artifactId: string,
    title: string,
    options?: { advanceToNewRow?: boolean }
  ) => void;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  openHref?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(artifact.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const finish = (save: boolean, advanceToNewRow = false) => {
    if (save && draft.trim()) {
      onCommit(artifact.id, draft, { advanceToNewRow });
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
            finish(true, true);
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
      <a
        className="min-w-0 max-w-[calc(100%-4rem)] shrink-0 text-left hover:underline"
        href={openHref ?? "#"}
        onClick={(event) => {
          // The shell owns detail state and writes the durable URL itself.
          // Prevent a full Next route transition here so newly created,
          // in-memory prototype records are not replaced by fixture data.
          event.preventDefault();
          event.stopPropagation();
          onOpenArtifact(artifact);
        }}
      >
        <GenericArtifactLead artifact={artifact} />
      </a>
      <button
        aria-label={`Edit artifact name for ${artifact.slug}`}
        className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/lead:opacity-100"
        data-grid-primary-editor=""
        onClick={() => setEditing(true)}
        type="button"
      >
        <PencilIcon className="size-3.5" />
      </button>
      <span
        aria-hidden
        className="h-full min-w-8 flex-1 cursor-default"
        data-row-selection-surface=""
      />
    </div>
  );
}

export function GenericArtifactCard({
  additionalColumns,
  artifact,
  columns,
  customFields,
  favorited,
  onFavoriteChange,
  onOpenArtifact,
  onSelectedChange,
  selected,
}: {
  additionalColumns: readonly ArtifactListColumnExtension[];
  artifact: GenericArtifact;
  columns: readonly GridTableColumn[];
  customFields: CustomFieldDefinition[];
  favorited: boolean;
  onFavoriteChange: (favorited: boolean) => void;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  onSelectedChange: (selected: boolean) => void;
  selected: boolean;
}) {
  return (
    <Card
      className={cn(
        "gap-3 py-4",
        selected && "border-primary/30 bg-primary/10"
      )}
      data-state={selected ? "selected" : undefined}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (
          target.closest("button, a, input, textarea, select, [role='button']")
        ) {
          return;
        }
        onSelectedChange(!selected);
      }}
    >
      <CardHeader className="flex flex-row items-center gap-2 px-4">
        <button
          className="min-w-0 flex-1 text-left"
          onClick={() => onOpenArtifact(artifact)}
          type="button"
        >
          <GenericArtifactLead artifact={artifact} />
        </button>
        <FavoriteButton
          addLabel={`Add ${artifact.title} to favorites`}
          isFavorite={favorited}
          onToggle={onFavoriteChange}
          removeLabel={`Remove ${artifact.title} from favorites`}
        />
      </CardHeader>
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4">
        {columns.map((column) => (
          <div className="contents" key={column.id}>
            <span className="text-muted-foreground text-xs">
              {column.label}
            </span>
            <span className="min-w-0 text-sm">
              {additionalColumns
                .find((extension) => extension.id === column.id)
                ?.renderCell(artifact) ??
                renderGenericArtifactCell(column.id, artifact, customFields)}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ArtifactTablePagination({
  page,
  pageSize,
  rangeStart,
  rangeEnd,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: (typeof PAGE_SIZES)[number];
  rangeStart: number;
  rangeEnd: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: (typeof PAGE_SIZES)[number]) => void;
}) {
  return (
    <div className="flex shrink-0 flex-nowrap items-center gap-4 overflow-x-auto border-t px-4 py-3">
      <div className="flex shrink-0 items-center gap-3 whitespace-nowrap text-muted-foreground text-sm">
        <span className="flex shrink-0 items-center gap-2">
          <span>Rows per page</span>
          <Select
            onValueChange={(value) =>
              onPageSizeChange(Number(value) as (typeof PAGE_SIZES)[number])
            }
            value={String(pageSize)}
          >
            <SelectTrigger
              aria-label="Rows per page"
              className="min-w-16"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </span>
        <span className="tabular-nums">
          {rangeStart}–{rangeEnd} of {total}
        </span>
      </div>
      <TablePagination
        className="mx-0 ml-auto w-auto min-w-max shrink-0"
        onPageChange={onPageChange}
        page={page}
        totalPages={totalPages}
      />
    </div>
  );
}

export function renderGenericArtifactCell(
  columnId: string,
  artifact: GenericArtifact,
  customFields: CustomFieldDefinition[],
  onArtifactChange?: (
    artifactId: string,
    patch: Partial<GenericArtifact>
  ) => void
): ReactNode {
  const customField = customFields.find((field) => field.id === columnId);
  if (customField) {
    return <CustomFieldCell artifact={artifact} field={customField} />;
  }
  switch (columnId) {
    case "collaborators":
      return (
        <CollaboratorsCell
          names={artifact.collaborators}
          onChange={(collaborators) =>
            onArtifactChange?.(artifact.id, { collaborators })
          }
        />
      );
    case "status":
      return (
        <EditableStatusCell
          initialStatus={artifact.status}
          onChange={(status) => onArtifactChange?.(artifact.id, { status })}
        />
      );
    case "tags":
      return (
        <EditableTagsCell
          initialTags={artifact.tags}
          onChange={(tags) => onArtifactChange?.(artifact.id, { tags })}
        />
      );
    case "currentVersion":
      return (
        <button className="font-mono text-sm hover:underline" type="button">
          {artifact.currentVersion}
        </button>
      );
    case "comments":
      return (
        <button
          aria-label={`${artifact.commentCount} comments`}
          className="flex items-center gap-1.5 text-muted-foreground text-sm hover:text-foreground"
          type="button"
        >
          <MessageSquareIcon className="size-3.5" />
          {artifact.commentCount}
        </button>
      );
    case "owner":
      return (
        <EditableOwnerCell
          initialInitials={artifact.ownerInitials}
          initialOwner={artifact.owner}
          onChange={(owner) => onArtifactChange?.(artifact.id, owner)}
        />
      );
    case "updated":
      return (
        <span className="text-muted-foreground text-xs">
          {artifact.updated}
        </span>
      );
    default:
      return null;
  }
}

function CollaboratorsCell({
  names,
  onChange,
}: {
  names: readonly string[];
  onChange?: (names: string[]) => void;
}) {
  const [selected, setSelected] = useState([...names]);
  useEffect(() => setSelected([...names]), [names]);
  return (
    <CollaboratorsEditor
      emptyLabel="—"
      names={selected}
      onChange={(next) => {
        setSelected(next);
        onChange?.(next);
      }}
      showEditIndicator={false}
    />
  );
}

function EditableStatusCell({
  initialStatus,
  onChange,
}: {
  initialStatus: ArtifactStatus;
  onChange?: (status: ArtifactStatus) => void;
}) {
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => setStatus(initialStatus), [initialStatus]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Edit status, currently ${status}`}
          className="rounded-md px-1 py-0.5 text-left hover:bg-muted"
          type="button"
        >
          <StatusChip status={status} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            const previous = status;
            const next = value as ArtifactStatus;
            setStatus(next);
            onChange?.(next);
            showSavedToast("Status updated", () => {
              setStatus(previous);
              onChange?.(previous);
            });
          }}
          value={status}
        >
          {Object.values(ArtifactStatus).map((value) => (
            <DropdownMenuRadioItem
              className={inlineEditorRadioItemClassName}
              key={value}
              value={value}
            >
              <StatusChip status={value} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
