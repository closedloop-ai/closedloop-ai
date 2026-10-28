"use client";

import type { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  Card,
  CardContent,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import { CountCell } from "@repo/design-system/components/ui/count-cell";
import { FavoriteButton } from "@repo/design-system/components/ui/favorite-button";
import { GridContextualAction } from "@repo/design-system/components/ui/grid-interaction-contract";
import type { GridTableV2Column as GridTableColumn } from "@repo/design-system/components/ui/grid-table-v2";
import { Input } from "@repo/design-system/components/ui/input";
import { MonoIdCell } from "@repo/design-system/components/ui/mono-id-cell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { TableCustomFieldDefinition as CustomFieldDefinition } from "@repo/design-system/components/ui/table-add-field-dialog";
import { TablePagination } from "@repo/design-system/components/ui/table-pagination-v2";
import type { CountNoun } from "@repo/design-system/lib/count-noun";
import type { GridTableV2Column } from "@repo/design-system/lib/grid-table-v2-types";
import { cn } from "@repo/design-system/lib/utils";
import { MessageSquareIcon, PencilIcon } from "lucide-react";
import {
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { GenericArtifactStatusEditor } from "../../generic-artifact-status-mark";
import type { GenericArtifact } from "../fixtures";
import { CustomFieldCell } from "./artifact-custom-field-cell";
import {
  EditableOwnerCell,
  EditableTagsCell,
  showSavedToast,
} from "./artifact-list-custom-cells";
import {
  type ArtifactListColumnExtension,
  kindIcon,
  PAGE_SIZES,
} from "./artifact-list-model";
import { CollaboratorsEditor } from "./generic-artifact-detail-shell";

export function GenericArtifactLead({
  artifact,
  narrow = false,
  showIcon = true,
  showSlug = true,
}: {
  artifact: GenericArtifact;
  showIcon?: boolean;
  /** Phone-width row: the slug yields width to the one-line title (ISS-12959). */
  narrow?: boolean;
  showSlug?: boolean;
}) {
  const Icon = kindIcon[artifact.kind];

  return (
    <span className="flex min-w-0 items-center gap-2 font-medium text-sm">
      {showIcon ? (
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      ) : null}
      {showSlug ? (
        <span
          className={cn(
            "font-normal text-muted-foreground",
            narrow ? "min-w-0 truncate" : "shrink-0"
          )}
        >
          {artifact.slug}
        </span>
      ) : null}
      <span className={narrow ? "min-w-0 flex-1 truncate" : "truncate"}>
        {artifact.title}
      </span>
    </span>
  );
}

export function EditableArtifactLead({
  artifact,
  linkComponent: LinkComponent = "a",
  onCommit,
  onOpenArtifact,
  openHref,
  openTarget,
  showSlug = true,
  variant = ArtifactLeadVariant.List,
  narrow = false,
}: {
  artifact: GenericArtifact;
  onCommit: (
    artifactId: string,
    title: string,
    options?: { advanceToNewRow?: boolean }
  ) => void;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  openHref?: string;
  openTarget?: "_blank";
  showSlug?: boolean;
  variant?: ArtifactLeadVariant;
  /** Phone-width row: the title link takes the free width (ISS-12959). */
  narrow?: boolean;
  linkComponent?:
    | "a"
    | ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>;
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
    <div
      className={cn(
        "group/lead flex w-full min-w-0",
        variant === ArtifactLeadVariant.Board && "items-start",
        variant !== ArtifactLeadVariant.Board && "h-8 items-center"
      )}
    >
      <LinkComponent
        className={cn(
          "min-w-0 text-left hover:underline",
          variant === ArtifactLeadVariant.Board && "flex-1",
          variant !== ArtifactLeadVariant.Board &&
            (narrow ? "flex-1" : "max-w-[calc(100%-4rem)] shrink-0")
        )}
        href={openHref ?? "#"}
        onClick={(event) => {
          // The shell owns detail state and writes the durable URL itself.
          // Prevent a full Next route transition here so newly created,
          // in-memory prototype records are not replaced by fixture data.
          event.stopPropagation();
          if (openTarget) {
            return;
          }
          if (
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          event.preventDefault();
          onOpenArtifact(artifact);
        }}
        rel={openTarget ? "noopener noreferrer" : undefined}
        target={openTarget}
      >
        {variant === ArtifactLeadVariant.Board ? (
          <span className="whitespace-normal font-medium text-base leading-6">
            {artifact.title}
          </span>
        ) : (
          <GenericArtifactLead
            artifact={artifact}
            narrow={narrow}
            showSlug={showSlug}
          />
        )}
      </LinkComponent>
      <GridContextualAction asChild legacyReveal="lead">
        <button
          aria-label={`Edit artifact name for ${artifact.slug}`}
          className={cn(
            "ml-1 flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            // AC-025: on a phone nothing hovers, so the hidden pencil must not
            // catch a tap meant for the row.
            narrow &&
              "pointer-events-none focus-visible:pointer-events-auto group-hover/lead:pointer-events-auto"
          )}
          data-grid-primary-editor=""
          onClick={(event) => {
            event.stopPropagation();
            setEditing(true);
          }}
          type="button"
        >
          <PencilIcon className="size-3.5" />
        </button>
      </GridContextualAction>
      <span
        aria-hidden
        className={narrow ? "hidden" : "h-full min-w-8 flex-1 cursor-default"}
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
  referenceArtifacts,
  selected,
  selectionManagedByWrapper = false,
  renderCell,
  renderLead,
}: {
  additionalColumns: readonly ArtifactListColumnExtension[];
  artifact: GenericArtifact;
  columns: readonly GridTableColumn[];
  customFields: CustomFieldDefinition[];
  favorited: boolean;
  onFavoriteChange: (favorited: boolean) => void;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  onSelectedChange: (selected: boolean) => void;
  referenceArtifacts: readonly GenericArtifact[];
  selected: boolean;
  selectionManagedByWrapper?: boolean;
  renderCell?: (columnId: string, artifact: GenericArtifact) => ReactNode;
  renderLead?: (artifact: GenericArtifact) => ReactNode;
}) {
  return (
    <Card
      className={cn(
        "gap-3 py-4",
        selected && "border-primary/30 bg-primary/10"
      )}
      data-state={selected ? "selected" : undefined}
      onClick={
        selectionManagedByWrapper
          ? undefined
          : (event) => {
              const target = event.target as HTMLElement;
              if (
                target.closest(
                  "button, a, input, textarea, select, [role='button']"
                )
              ) {
                return;
              }
              onSelectedChange(!selected);
            }
      }
    >
      <CardHeader className="flex flex-row items-center gap-2 px-4">
        {renderLead ? (
          <div className="min-w-0 flex-1 text-left">{renderLead(artifact)}</div>
        ) : (
          <button
            className="min-w-0 flex-1 text-left"
            onClick={() => onOpenArtifact(artifact)}
            type="button"
          >
            <GenericArtifactLead artifact={artifact} />
          </button>
        )}
        <GridContextualAction>
          <FavoriteButton
            addLabel={`Add ${artifact.title} to favorites`}
            isFavorite={favorited}
            onToggle={onFavoriteChange}
            removeLabel={`Remove ${artifact.title} from favorites`}
          />
        </GridContextualAction>
      </CardHeader>
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4">
        {columns.map((column) => (
          <div className="contents" key={column.id}>
            <span className="text-muted-foreground text-xs">
              {column.label}
            </span>
            <span className="min-w-0 text-sm">
              {renderCell
                ? renderCell(column.id, artifact)
                : (additionalColumns
                    .find((extension) => extension.id === column.id)
                    ?.renderCell(artifact) ??
                  renderGenericArtifactCell(
                    column.id,
                    artifact,
                    customFields,
                    referenceArtifacts
                  ))}
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
  referenceArtifacts: readonly GenericArtifact[],
  onArtifactChange?: (
    artifactId: string,
    patch: Partial<GenericArtifact>
  ) => void,
  statusTriggerVariant?: typeof ArtifactStatusVariant.Icon
): ReactNode {
  const customField = customFields.find((field) => field.id === columnId);
  if (customField) {
    return (
      <CustomFieldCell
        artifact={artifact}
        field={customField}
        referenceArtifacts={referenceArtifacts}
      />
    );
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
        <GenericArtifactStatusEditor
          artifact={artifact}
          onChange={(status) => {
            const previous = artifact.status;
            const previousRaw = artifact.statusRaw;
            onArtifactChange?.(artifact.id, {
              status,
              statusRaw: undefined,
            });
            showSavedToast("Status updated", () =>
              onArtifactChange?.(artifact.id, {
                status: previous,
                statusRaw: previousRaw,
              })
            );
          }}
          triggerVariant={statusTriggerVariant}
        />
      );
    case "tags":
      return (
        <EditableTagsCell
          initialTags={artifact.tags}
          onChange={(tags) => onArtifactChange?.(artifact.id, { tags })}
        />
      );
    // ISS-6384: both cells were hand-rolled buttons with NO click handler
    // behind them — an affordance a keyboard user can reach and nothing
    // happens. The shared cells are non-interactive unless a handler is
    // supplied, so the prototype now shows what the primitives actually do:
    // `MonoIdCell` names an opaque version for a screen reader, and `CountCell`
    // keeps a true zero apart from a count that never arrived.
    case "currentVersion":
      return <MonoIdCell label="Version" value={artifact.currentVersion} />;
    case "comments":
      return (
        <CountCell
          count={artifact.commentCount}
          icon={<MessageSquareIcon aria-hidden className="size-3.5" />}
          noun={COMMENTS_NOUN}
        />
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

/** ISS-6384: singular and plural, so a one-comment row reads "1 comment". */
const COMMENTS_NOUN: CountNoun = { one: "comment", other: "comments" };

/** Generic Artifact's captured-main card, retained only for flag-off parity. */
export function GenericArtifactCardCompatibility({
  additionalColumns,
  artifact,
  columns,
  customFields,
  favoriteAction,
  onOpenArtifact,
  onSelectedChange,
  referenceArtifacts,
  selected,
  renderCell,
  renderLead,
}: {
  additionalColumns: readonly ArtifactListColumnExtension[];
  artifact: GenericArtifact;
  columns: readonly GridTableV2Column[];
  customFields: CustomFieldDefinition[];
  favoriteAction?: ReactNode;
  onOpenArtifact: (artifact: GenericArtifact) => void;
  onSelectedChange: (selected: boolean) => void;
  referenceArtifacts: readonly GenericArtifact[];
  selected: boolean;
  renderCell?: (columnId: string, artifact: GenericArtifact) => ReactNode;
  renderLead?: (artifact: GenericArtifact) => ReactNode;
}) {
  return (
    <Card
      className={cn(
        "gap-3 py-4",
        selected && "border-primary/30 bg-primary/10"
      )}
      data-state={selected ? "selected" : undefined}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            "button, a, input, textarea, select, [role='button']"
          )
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
          {renderLead ? (
            renderLead(artifact)
          ) : (
            <GenericArtifactLead artifact={artifact} />
          )}
        </button>
        {favoriteAction}
      </CardHeader>
      <CardContent className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4">
        {columns.map((column) => (
          <div className="contents" key={column.id}>
            <span className="text-muted-foreground text-xs">
              {column.label}
            </span>
            <span className="min-w-0 text-sm">
              {renderCell
                ? renderCell(column.id, artifact)
                : (additionalColumns
                    .find((extension) => extension.id === column.id)
                    ?.renderCell(artifact) ??
                  renderGenericArtifactCell(
                    column.id,
                    artifact,
                    customFields,
                    referenceArtifacts
                  ))}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export const ArtifactLeadVariant = { List: "list", Board: "board" } as const;
export type ArtifactLeadVariant =
  (typeof ArtifactLeadVariant)[keyof typeof ArtifactLeadVariant];
