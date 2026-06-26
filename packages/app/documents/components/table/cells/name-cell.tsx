"use client";

import type { DocumentStatus } from "@repo/api/src/types/document";
import {
  DOCUMENT_STATUS_OPTIONS,
  isActiveGenerationStatus,
} from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { TruncatedTitle } from "@repo/app/documents/components/table/cells/cell-tooltip";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUS_TO_ICON,
} from "@repo/app/projects/lib/project-constants";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { ChevronRightIcon } from "lucide-react";
import { useContext } from "react";

export function TypeIcon({ item }: { item: DocumentRowItem }) {
  const config = getRowTypeConfig(item);
  if (!config) {
    return null;
  }
  const Icon = config.icon;
  return (
    <span className="mr-1 ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

type NameCellProps = {
  item: DocumentRowItem;
  showCheckbox: boolean;
  isSelected: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  indentDepth?: number;
  href?: string | null;
  rankSlot?: React.ReactNode;
  reserveChevronSlot?: boolean;
  selectMode?: boolean;
};

/**
 * Name column for every row kind. Dispatches to a per-kind subcomponent
 * (project / branch-session / document) so each layout stays small and
 * independently readable rather than living in one branching block.
 */
export function NameCell(props: NameCellProps) {
  const { item } = props;
  if (item.kind === "project") {
    return <ProjectNameCell {...props} item={item} />;
  }
  if (item.kind === "branch" || item.kind === "session") {
    return (
      <ArtifactNameCell
        hasChevron={props.isExpanded !== undefined}
        href={props.href}
        indentDepth={props.indentDepth}
        isExpanded={props.isExpanded}
        item={item}
        onToggleExpand={props.onToggleExpand}
        rankSlot={props.rankSlot}
        reserveChevronSlot={props.reserveChevronSlot}
      />
    );
  }
  return <DocumentNameCell {...props} item={item} />;
}

// ---- Per-kind name cells (extracted from NameCell for readability) ----

/** Selection checkbox shared by the project and document name cells. */
function SelectionCheckbox({
  id,
  showCheckbox,
  isSelected,
  selectMode,
  onSelectionChange,
}: {
  id: string;
  showCheckbox: boolean;
  isSelected: boolean;
  selectMode?: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
}) {
  if (!showCheckbox) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex h-7 w-7 shrink-0 items-center justify-center transition-opacity",
        isSelected || selectMode
          ? "opacity-100"
          : "opacity-0 group-hover/row:opacity-100"
      )}
    >
      <Checkbox
        checked={isSelected}
        onCheckedChange={(checked) => onSelectionChange?.(id, checked === true)}
      />
    </div>
  );
}

/** Title link shared by the project and document name cells. */
function NameLink({ href, text }: { href?: string | null; text: string }) {
  if (href) {
    return (
      <Link className="ml-1.5 min-w-0 flex-1" href={href} prefetch={false}>
        <TruncatedTitle text={text} />
      </Link>
    );
  }
  return (
    <div className="ml-1.5 min-w-0 flex-1">
      <TruncatedTitle text={text} />
    </div>
  );
}

const NAME_CELL_CLASS_NAME =
  "flex h-full w-full min-w-0 items-center overflow-hidden pr-3 pl-2";

// Project rows: folder icon + optional slug + completion % + name.
function ProjectNameCell({
  item,
  showCheckbox,
  isSelected,
  onSelectionChange,
  selectMode,
  href,
  rankSlot,
}: Omit<NameCellProps, "item"> & {
  item: Extract<DocumentRowItem, { kind: "project" }>;
}) {
  return (
    <div className={NAME_CELL_CLASS_NAME}>
      {rankSlot}
      <SelectionCheckbox
        id={item.data.id}
        isSelected={isSelected}
        onSelectionChange={onSelectionChange}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
      />
      <span className="mr-1.5 ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {isDisplayableSlug(item.data.slug) ? item.data.slug : null}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center">
            <StatusPercentageIcon
              size={16}
              value={item.data.completionPercentage}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {Math.round(item.data.completionPercentage)}% of artifacts complete
        </TooltipContent>
      </Tooltip>
      <NameLink href={href} text={item.data.name} />
    </div>
  );
}

// Document rows: indent + chevron + type icon + slug + status + title.
function DocumentNameCell({
  item,
  showCheckbox,
  isSelected,
  onSelectionChange,
  isExpanded,
  onToggleExpand,
  indentDepth = 0,
  href,
  rankSlot,
  reserveChevronSlot,
  selectMode,
}: Omit<NameCellProps, "item"> & {
  item: Extract<DocumentRowItem, { kind: "document" }>;
}) {
  const { onUpdateStatus } = useContext(RowEditContext);
  const statusIcon =
    DOCUMENT_STATUS_TO_ICON[item.data.status as DocumentStatus];
  const thinking =
    item.data.generationStatus != null &&
    isActiveGenerationStatus(item.data.generationStatus.status);

  return (
    <div className={NAME_CELL_CLASS_NAME}>
      {rankSlot}
      <SelectionCheckbox
        id={item.data.id}
        isSelected={isSelected}
        onSelectionChange={onSelectionChange}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
      />
      <IndentSpacer depth={indentDepth} />
      <ChevronSlot
        hasChevron={isExpanded !== undefined}
        indented={indentDepth > 0}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        reserveSlot={reserveChevronSlot}
      />
      <TypeIcon item={item} />
      <span className="mr-1.5 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {isDisplayableSlug(item.data.slug) ? item.data.slug : null}
      </span>
      <DocumentStatusControl
        item={item}
        onUpdateStatus={onUpdateStatus}
        statusIcon={statusIcon}
        thinking={thinking}
      />
      <NameLink href={href} text={item.data.title} />
    </div>
  );
}

/** Status icon for a document row: an edit dropdown when editable, else a tooltip. */
function DocumentStatusControl({
  item,
  onUpdateStatus,
  statusIcon,
  thinking,
}: {
  item: Extract<DocumentRowItem, { kind: "document" }>;
  onUpdateStatus?: (id: string, status: DocumentStatus) => void;
  statusIcon: React.ComponentProps<typeof StatusIcon>["status"];
  thinking: boolean;
}) {
  if (!onUpdateStatus) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center">
            <StatusIcon size={16} status={statusIcon} thinking={thinking} />
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {
            DOCUMENT_STATUS_LABELS[
              item.data.status as keyof typeof DOCUMENT_STATUS_LABELS
            ]
          }
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
          type="button"
        >
          <StatusIcon size={16} status={statusIcon} thinking={thinking} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {DOCUMENT_STATUS_OPTIONS.map((value) => (
          <DropdownMenuItem
            key={value}
            onClick={() => {
              onUpdateStatus(item.data.id, value);
            }}
          >
            <StatusIcon
              size={16}
              status={
                DOCUMENT_STATUS_TO_ICON[
                  value as keyof typeof DOCUMENT_STATUS_TO_ICON
                ]
              }
            />
            {
              DOCUMENT_STATUS_LABELS[
                value as keyof typeof DOCUMENT_STATUS_LABELS
              ]
            }
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---- Non-document artifact name cell (extracted to keep NameCell cognitive complexity in bounds) ----

function ArtifactNameCell({
  item,
  hasChevron,
  isExpanded,
  onToggleExpand,
  indentDepth = 0,
  href,
  rankSlot,
  reserveChevronSlot,
}: {
  item: Extract<DocumentRowItem, { kind: "branch" | "session" }>;
  hasChevron: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  indentDepth?: number;
  href?: string | null;
  rankSlot?: React.ReactNode;
  reserveChevronSlot?: boolean;
}) {
  const className =
    "flex h-full w-full min-w-0 items-center overflow-hidden pr-3 pl-2";
  const statusIcon = getRowTypeConfig(item)?.statusIcon ?? "in-progress";

  return (
    <div className={className}>
      {rankSlot}
      <IndentSpacer depth={indentDepth} />
      <ChevronSlot
        hasChevron={hasChevron}
        indented={indentDepth > 0}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        reserveSlot={reserveChevronSlot}
      />
      <TypeIcon item={item} />
      <span className="mr-1.5 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {isDisplayableSlug(item.data.slug) ? item.data.slug : null}
      </span>
      <div className="flex h-7 w-7 shrink-0 items-center justify-center">
        <StatusIcon size={16} status={statusIcon} />
      </div>
      {href ? (
        <Link className="ml-1.5 min-w-0 flex-1" href={href} prefetch={false}>
          <TruncatedTitle text={item.data.name} />
        </Link>
      ) : (
        <div className="ml-1.5 min-w-0 flex-1">
          <TruncatedTitle text={item.data.name} />
        </div>
      )}
    </div>
  );
}

/**
 * Leading spacer that shifts a nested row right by one slot width per tree
 * level. Width must stay equal to the chevron/rank slot width (28px / w-7) so
 * each depth level lines a child up under its parent's icon column.
 */
function IndentSpacer({ depth }: { depth: number }) {
  if (depth <= 0) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="shrink-0"
      style={{ width: depth * 28 }}
    />
  );
}

function ChevronSlot({
  hasChevron,
  indented,
  isExpanded,
  onToggleExpand,
  reserveSlot,
}: {
  hasChevron: boolean;
  indented?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  reserveSlot?: boolean;
}) {
  if (hasChevron) {
    return (
      <button
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Collapse" : "Expand"}
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${onToggleExpand ? "hover:bg-muted" : "cursor-default opacity-30"}`}
        onClick={() => {
          if (onToggleExpand) {
            onToggleExpand();
          }
        }}
        tabIndex={onToggleExpand ? 0 : -1}
        type="button"
      >
        <ChevronRightIcon
          className={`h-4 w-4 text-muted-foreground ${isExpanded ? "rotate-90" : ""} transition-transform`}
        />
      </button>
    );
  }
  if (indented || reserveSlot) {
    return <div aria-hidden="true" className="h-7 w-7 shrink-0" />;
  }
  return null;
}
