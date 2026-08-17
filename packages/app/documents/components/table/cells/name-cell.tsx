"use client";

import type {
  ArtifactStatus,
  DocumentStatus,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentType,
  ISSUE_STATUS_OPTIONS,
} from "@repo/api/src/types/document";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { DocumentStatusIcon } from "@repo/app/documents/components/document-status-icon";
import { IssueStatusIcon } from "@repo/app/documents/components/issue-status-icon";
import { TruncatedTitle } from "@repo/app/documents/components/table/cells/cell-tooltip";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import { getRowTypeConfig } from "@repo/app/documents/components/table/row-type-registry";
import {
  ARTIFACT_STATUS_LABELS,
  formatProjectCompletionSummary,
  PROJECT_COMPLETION_EMPTY_SUMMARY,
} from "@repo/app/projects/lib/project-constants";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { PROJECT_COMPLETION_EMPTY_STATE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
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

function TypeIcon({ item }: { item: DocumentRowItem }) {
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
        // FEA-3866: revealed on row-hover for a mouse, but always visible on a
        // touch pointer (`touch:opacity-100`) — there is no hover to reveal it.
        isSelected || selectMode
          ? "opacity-100"
          : "opacity-0 touch:opacity-100 group-hover/row:opacity-100"
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
  // `completionPopulationEmpty` (additive, ISS-4679) means the population is
  // empty (no documents/issues), which the ring slot shows as a muted dash
  // (ISS-4835) rather than any ring, so it separates from both a solid 0% and
  // the Backlog dashed ring on the issue rows directly below it. The wire keeps
  // `completionPercentage` numeric
  // for version-skew safety, so the empty case is carried by the flag, not by a
  // null percentage. One string drives both the visible tooltip and the icon's
  // accessible name, so a screen reader hears the same population the sighted
  // user reads.
  //
  // ISS-4792 (ISS-4779 closed-by-default): the empty-population state is gated on
  // the `project-completion-empty-state` flag (default OFF). With it off, an
  // empty population falls through to the PRIOR behavior — a solid 0% ring named
  // "0% of documents and issues complete" — so the surface is unchanged. Uses the
  // optional flag hook so a mount site without a flag provider (Storybook,
  // mini-table tests) degrades to OFF rather than crashing.
  const emptyStateEnabled = useFeatureFlagEnabledOptional(
    PROJECT_COMPLETION_EMPTY_STATE_FEATURE_FLAG_KEY
  );
  const completionPercentage = item.data.completionPercentage;
  const isEmpty =
    emptyStateEnabled === true && item.data.completionPopulationEmpty === true;
  const completionSummary = isEmpty
    ? PROJECT_COMPLETION_EMPTY_SUMMARY
    : formatProjectCompletionSummary(completionPercentage);
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
          {/*
            Focusable (button, no action) so the tooltip opens on keyboard focus
            and tap, not hover alone — the ring is the only place this population
            is named, and a plain div reaches neither a keyboard nor a touch
            user. The accessible name stays on the ring itself (`label`), so this
            wrapper carries none and is not a second name.
          */}
          <button
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
          >
            <StatusPercentageIcon
              label={completionSummary}
              size={16}
              value={isEmpty ? null : completionPercentage}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent>{completionSummary}</TooltipContent>
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
      <DocumentStatusControl item={item} onUpdateStatus={onUpdateStatus} />
      <NameLink href={href} text={item.data.title} />
    </div>
  );
}

/**
 * Status icon for one status of a document row, in that row's vocabulary
 * (Documents and Features carry disjoint status sets — PRD-495).
 */
function RowStatusIcon({
  isFeature,
  status,
}: {
  isFeature: boolean;
  status: ArtifactStatus;
}) {
  return isFeature ? (
    <IssueStatusIcon size={16} status={status as IssueStatus} />
  ) : (
    <DocumentStatusIcon size={16} status={status as DocumentStatus} />
  );
}

/** Status icon for a document row: an edit dropdown when editable, else a tooltip. */
function DocumentStatusControl({
  item,
  onUpdateStatus,
}: {
  item: Extract<DocumentRowItem, { kind: "document" }>;
  onUpdateStatus?: (id: string, status: ArtifactStatus) => void;
}) {
  const isFeature = item.data.type === DocumentType.Feature;
  const label = ARTIFACT_STATUS_LABELS[item.data.status];

  if (!onUpdateStatus) {
    return (
      <ArtifactStatusTooltip label={label}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <RowStatusIcon isFeature={isFeature} status={item.data.status} />
        </div>
      </ArtifactStatusTooltip>
    );
  }
  // Offer the vocabulary that matches this row's artifact kind (PRD-495).
  // Features expose the full set including TRIAGE — humans may move a row to any
  // status; TRIAGE is only excluded as the human-create default, not as an option.
  const statusOptions = isFeature
    ? ISSUE_STATUS_OPTIONS
    : DOCUMENT_STATUS_OPTIONS;
  return (
    <DropdownMenu>
      <ArtifactStatusTooltip label={label}>
        <DropdownMenuTrigger asChild>
          <button
            aria-label={label}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            type="button"
          >
            <RowStatusIcon isFeature={isFeature} status={item.data.status} />
          </button>
        </DropdownMenuTrigger>
      </ArtifactStatusTooltip>
      <DropdownMenuContent align="start">
        {statusOptions.map((value) => (
          <DropdownMenuItem
            key={value}
            onClick={() => {
              onUpdateStatus(item.data.id, value);
            }}
          >
            <RowStatusIcon isFeature={isFeature} status={value} />
            {ARTIFACT_STATUS_LABELS[value]}
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
  const rowTypeConfig = getRowTypeConfig(item);
  const statusIcon = rowTypeConfig?.statusIcon ?? "in-progress";
  const statusLabel = rowTypeConfig?.statusLabel;

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
      <ArtifactStatusTooltip label={statusLabel}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <StatusIcon
            {...(statusLabel ? { "aria-label": statusLabel } : {})}
            size={16}
            status={statusIcon}
          />
        </div>
      </ArtifactStatusTooltip>
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
 * Shared hover tooltip for every status icon in the table: document rows
 * (read-only and the editable dropdown trigger) and branch/session rows.
 * Renders children unwrapped when no label is available.
 */
function ArtifactStatusTooltip({
  children,
  label,
}: {
  children: React.ReactElement;
  label?: string;
}) {
  if (!label) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
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
