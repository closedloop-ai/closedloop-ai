"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { ArtifactStatus } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { DocumentStatusMutationOperation } from "@repo/api/src/types/document-status-mutation";
import {
  type DisplayedSessionStatus,
  isRecognizedSessionStatus,
} from "@repo/api/src/types/session-status";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import {
  ArtifactStatusIconFor,
  ArtifactStatusMenu,
  ArtifactStatusTooltip,
} from "@repo/app/documents/components/artifact-field-menus";
import { TruncatedTitle } from "@repo/app/documents/components/table/cells/cell-tooltip";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { RowEditContext } from "@repo/app/documents/components/table/row-edit-context";
import {
  getRowTypeConfig,
  normalizeBranchStatus,
  resolveServedSessionDisplayStatus,
} from "@repo/app/documents/components/table/row-type-registry";
import type { DocumentRowSelectionChange } from "@repo/app/documents/hooks/use-documents-legacy-row-selection";
import { documentRowStatusEvidence } from "@repo/app/documents/lib/artifact-row-adapter";
import { documentArtifactStatusCapability } from "@repo/app/documents/lib/artifact-status-capability";
import {
  ARTIFACT_STATUS_LABELS,
  formatProjectCompletionSummary,
  PROJECT_COMPLETION_EMPTY_SUMMARY,
} from "@repo/app/projects/lib/project-constants";
import { ArtifactStatus as UniversalArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  branchPullRequestStatusView,
  documentStatusView,
  sessionStatusView,
} from "@repo/app/shared/lib/artifact-status-adapter";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import {
  ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY,
  FAILED_SESSION_STATUS_ICON_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { StatusDash } from "@repo/design-system/components/ui/status-icon-primitives";
import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { formatGridCardSelectionLabel } from "@repo/design-system/lib/grid-table-aria";
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
  onSelectionChange?: DocumentRowSelectionChange;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  indentDepth?: number;
  href?: string | null;
  rankSlot?: React.ReactNode;
  reserveChevronSlot?: boolean;
  selectMode?: boolean;
  narrow?: boolean;
  placementCard?: boolean;
  placementSlug?: boolean;
  /**
   * Layout delta from the default cluster (ISS-9335). The padding here is right
   * for a host that owns the whole lead track itself; a host whose grid cell
   * already pads the track passes `px-0` so the gutters are not stated twice.
   */
  className?: string;
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
        className={props.className}
        hasChevron={props.isExpanded !== undefined}
        href={props.href}
        indentDepth={props.indentDepth}
        isExpanded={props.isExpanded}
        isSelected={props.isSelected}
        item={item}
        narrow={props.narrow}
        onSelectionChange={props.onSelectionChange}
        onToggleExpand={props.onToggleExpand}
        placementCard={props.placementCard}
        placementSlug={props.placementSlug}
        rankSlot={props.rankSlot}
        reserveChevronSlot={props.reserveChevronSlot}
        selectMode={props.selectMode}
        showCheckbox={props.showCheckbox}
      />
    );
  }
  return <DocumentNameCell {...props} item={item} />;
}

// Per-kind name cells (extracted from NameCell for readability)

/** Selection checkbox shared by the project and document name cells. */
function SelectionCheckbox({
  id,
  label,
  showCheckbox,
  isSelected,
  selectMode,
  onSelectionChange,
  focusReveal = false,
}: {
  id: string;
  label: string;
  showCheckbox: boolean;
  isSelected: boolean;
  selectMode?: boolean;
  onSelectionChange?: DocumentRowSelectionChange;
  focusReveal?: boolean;
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
          : cn(
              "opacity-0 touch:opacity-100 group-hover/row:opacity-100",
              focusReveal && "focus-within:opacity-100"
            )
      )}
    >
      <Checkbox
        aria-label={formatGridCardSelectionLabel(label, isSelected)}
        checked={isSelected}
        onClick={(event) => onSelectionChange?.(id, !isSelected, event)}
      />
    </div>
  );
}

/** Title link shared by the project and document name cells. */
function NameLink({
  disableNativeDrag,
  href,
  text,
}: {
  disableNativeDrag?: boolean;
  href?: string | null;
  text: string;
}) {
  const title = <TruncatedTitle text={text} />;
  if (href) {
    return (
      <Link
        className="ml-1.5 min-w-0 flex-1"
        draggable={disableNativeDrag ? false : undefined}
        href={href}
        prefetch={false}
      >
        {title}
      </Link>
    );
  }
  return <div className="ml-1.5 min-w-0 flex-1">{title}</div>;
}

const NAME_CELL_CLASS_NAME =
  "flex h-full w-full min-w-0 items-center overflow-hidden pr-3 pl-2";

// Project rows: folder icon + optional slug + completion % + name.
function ProjectNameCell({
  className,
  item,
  showCheckbox,
  isSelected,
  onSelectionChange,
  selectMode,
  href,
  rankSlot,
  narrow,
}: Omit<NameCellProps, "item"> & {
  item: Extract<DocumentRowItem, { kind: "project" }>;
}) {
  // `completionPopulationEmpty` (additive, ISS-4679) means the population is
  // empty (no documents/issues), which the ring slot shows as a muted dash
  // (ISS-4835) rather than any ring, so it separates from both a solid 0% and
  // the Backlog dashed ring on the issue rows directly below it. The wire keeps
  // `completionPercentage` numeric
  // for version-skew safety, so the empty case is carried by
  // `completionPopulationEmpty`, not by a null percentage. One string drives
  // both the visible tooltip and the icon's accessible name, so a screen reader
  // hears the same population the sighted user reads.
  const completionPercentage = item.data.completionPercentage;
  const isEmpty = item.data.completionPopulationEmpty === true;
  const completionSummary = isEmpty
    ? PROJECT_COMPLETION_EMPTY_SUMMARY
    : formatProjectCompletionSummary(completionPercentage);
  return (
    <div
      className={cn(
        NAME_CELL_CLASS_NAME,
        showCheckbox && SELECTABLE_NAME_CELL_INSET_CLASS_NAME,
        className
      )}
    >
      {rankSlot}
      <SelectionCheckbox
        id={item.data.id}
        isSelected={isSelected}
        label={item.data.name}
        onSelectionChange={onSelectionChange}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
      />
      {narrow ? null : (
        <DisplayableSlug className="ml-1" slug={item.data.slug} />
      )}
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
  className,
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
  narrow,
  placementCard,
  placementSlug,
}: Omit<NameCellProps, "item"> & {
  item: Extract<DocumentRowItem, { kind: "document" }>;
}) {
  const { onUpdateStatus } = useContext(RowEditContext);

  return (
    <div
      className={cn(
        NAME_CELL_CLASS_NAME,
        narrow && "h-auto overflow-visible",
        placementCard && "h-auto flex-wrap overflow-visible",
        showCheckbox && SELECTABLE_NAME_CELL_INSET_CLASS_NAME,
        className
      )}
    >
      {rankSlot}
      <SelectionCheckbox
        focusReveal={placementSlug}
        id={item.data.id}
        isSelected={isSelected}
        label={item.data.title}
        onSelectionChange={onSelectionChange}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
      />
      {narrow ? null : (
        <>
          <IndentSpacer depth={indentDepth} />
          <ChevronSlot
            hasChevron={isExpanded !== undefined}
            indented={indentDepth > 0}
            isExpanded={isExpanded}
            onToggleExpand={onToggleExpand}
            reserveSlot={reserveChevronSlot}
          />
          <TypeIcon item={item} />
        </>
      )}
      {narrow && (
        <>
          <ArtifactStatusControl item={item} onUpdateStatus={onUpdateStatus} />
          <NameLink href={href} text={item.data.title} />
        </>
      )}
      {!narrow && placementCard && (
        <>
          <ArtifactStatusControl item={item} onUpdateStatus={onUpdateStatus} />
          <div className="flex w-full min-w-0 items-center">
            <IndentSpacer depth={indentDepth} />
            <DisplayableSlug
              placementSlug={placementSlug}
              slug={item.data.slug}
            />
            <NameLink
              disableNativeDrag={placementSlug}
              href={href}
              text={item.data.title}
            />
          </div>
        </>
      )}
      {!(narrow || placementCard) && (
        <>
          <DisplayableSlug
            placementSlug={placementSlug}
            slug={item.data.slug}
          />
          <ArtifactStatusControl item={item} onUpdateStatus={onUpdateStatus} />
          <NameLink
            disableNativeDrag={placementSlug}
            href={href}
            text={item.data.title}
          />
        </>
      )}
    </div>
  );
}

/** Status icon for a document row: an edit dropdown when editable, else a tooltip. */
function ArtifactStatusControl({
  item,
  onUpdateStatus,
}: {
  item: DocumentRowItem;
  onUpdateStatus?: (
    id: string,
    status: ArtifactStatus,
    surface: ArtifactStatusEditSurface
  ) => void;
}) {
  const champion = useFeatureFlagEnabledOptional(
    UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY
  );
  const displayedSessionStatusEnabled = useFeatureFlagEnabledOptional(
    ARTIFACT_TABLE_DISPLAYED_SESSION_STATUS_FEATURE_FLAG_KEY
  );
  const sessionDisplayedStatus =
    displayedSessionStatusEnabled && item.kind === "session"
      ? resolveServedSessionDisplayStatus(item)
      : undefined;
  if (item.kind === "project") {
    return null;
  }
  if (champion) {
    return (
      <UniversalStatusControl
        item={item}
        onUpdateStatus={onUpdateStatus}
        sessionDisplayedStatus={sessionDisplayedStatus}
      />
    );
  }
  if (item.kind === "document") {
    return (
      <LegacyDocumentStatusControl
        item={item}
        onUpdateStatus={onUpdateStatus}
      />
    );
  }
  return (
    <LegacyArtifactNameCellStatus
      item={item}
      sessionDisplayedStatus={sessionDisplayedStatus}
    />
  );
}

function LegacyDocumentStatusControl({
  item,
  onUpdateStatus,
}: {
  item: Extract<DocumentRowItem, { kind: "document" }>;
  onUpdateStatus?: (
    id: string,
    status: ArtifactStatus,
    surface: ArtifactStatusEditSurface
  ) => void;
}) {
  const isFeature = item.data.type === DocumentType.Feature;
  const label = ARTIFACT_STATUS_LABELS[item.data.status];
  if (!onUpdateStatus) {
    return (
      <ArtifactStatusTooltip label={label}>
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <ArtifactStatusIconFor
            isFeature={isFeature}
            status={item.data.status}
          />
        </div>
      </ArtifactStatusTooltip>
    );
  }
  return (
    <ArtifactStatusMenu
      isFeature={isFeature}
      onSelect={(value) => {
        onUpdateStatus(
          item.data.id,
          value,
          ArtifactStatusEditSurface.InlineCell
        );
      }}
      tooltipLabel={label}
      trigger={
        <button
          aria-label={label}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
          type="button"
        >
          <ArtifactStatusIconFor
            isFeature={isFeature}
            status={item.data.status}
          />
        </button>
      }
    />
  );
}

function UniversalStatusControl({
  item,
  onUpdateStatus,
  sessionDisplayedStatus,
}: {
  item: DocumentRowItem;
  onUpdateStatus?: (
    id: string,
    status: ArtifactStatus,
    surface: ArtifactStatusEditSurface
  ) => void;
  sessionDisplayedStatus?: DisplayedSessionStatus;
}) {
  if (item.kind === "document") {
    const rawStatus = documentRowStatusEvidence(item.data);
    const view = documentStatusView(item.data.id, item.data.type, rawStatus);
    if (!onUpdateStatus) {
      return (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <UniversalArtifactStatus
            variant={ArtifactStatusVariant.Icon}
            view={view}
          />
        </div>
      );
    }
    return (
      <UniversalArtifactStatus
        capability={documentArtifactStatusCapability({
          documentType: item.data.type,
          operation: DocumentStatusMutationOperation.Single,
          rawStatus,
          statusMutation: item.data.statusMutation,
        })}
        onCommit={(commit) => {
          onUpdateStatus(
            commit.artifactId,
            commit.to as ArtifactStatus,
            ArtifactStatusEditSurface.InlineCell
          );
        }}
        surface={ArtifactStatusEditSurface.InlineCell}
        variant={ArtifactStatusVariant.Editor}
        view={view}
      />
    );
  }

  const rowTypeConfig = getRowTypeConfig(item, { sessionDisplayedStatus });
  const rawSessionStatus = item.data.status.toLowerCase();
  const view =
    item.kind === "branch"
      ? branchPullRequestStatusView(
          item.data.id,
          normalizeBranchStatus(item.data.status) ?? item.data.status
        )
      : sessionStatusView(
          item.data.id,
          sessionDisplayedStatus ?? rawSessionStatus,
          isRecognizedSessionStatus(rawSessionStatus)
            ? rawSessionStatus
            : item.data.status
        );
  const statusLabel = artifactStatusLabel(view);
  const statusDescription = rowTypeConfig?.statusDescription;
  const statusTooltip = statusDescription
    ? `${statusLabel}. ${statusDescription}`
    : statusLabel;
  return (
    <ArtifactStatusTooltip label={statusTooltip}>
      {statusDescription ? (
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
        >
          <UniversalArtifactStatus
            variant={ArtifactStatusVariant.Icon}
            view={view}
          />
        </button>
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <UniversalArtifactStatus
            variant={ArtifactStatusVariant.Icon}
            view={view}
          />
        </div>
      )}
    </ArtifactStatusTooltip>
  );
}

// Non-document artifact name cell (extracted to keep NameCell cognitive complexity in bounds)

function ArtifactNameCell({
  className,
  item,
  isSelected,
  hasChevron,
  isExpanded,
  onToggleExpand,
  indentDepth = 0,
  href,
  rankSlot,
  reserveChevronSlot,
  narrow,
  onSelectionChange,
  selectMode,
  showCheckbox,
  placementCard,
  placementSlug,
}: {
  className?: string;
  item: Extract<DocumentRowItem, { kind: "branch" | "session" }>;
  isSelected: boolean;
  hasChevron: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  indentDepth?: number;
  href?: string | null;
  rankSlot?: React.ReactNode;
  reserveChevronSlot?: boolean;
  narrow?: boolean;
  onSelectionChange?: DocumentRowSelectionChange;
  selectMode?: boolean;
  showCheckbox: boolean;
  placementCard?: boolean;
  placementSlug?: boolean;
}) {
  return (
    <div
      className={cn(
        NAME_CELL_CLASS_NAME,
        narrow && "h-auto overflow-visible",
        placementCard && "h-auto flex-wrap overflow-visible",
        showCheckbox && SELECTABLE_NAME_CELL_INSET_CLASS_NAME,
        className
      )}
    >
      {rankSlot}
      <SelectionCheckbox
        focusReveal={placementSlug}
        id={item.data.id}
        isSelected={isSelected}
        label={item.data.name}
        onSelectionChange={onSelectionChange}
        selectMode={selectMode}
        showCheckbox={showCheckbox}
      />
      {narrow ? null : (
        <>
          <IndentSpacer depth={indentDepth} />
          <ChevronSlot
            hasChevron={hasChevron}
            indented={indentDepth > 0}
            isExpanded={isExpanded}
            onToggleExpand={onToggleExpand}
            reserveSlot={reserveChevronSlot}
          />
          <TypeIcon item={item} />
        </>
      )}
      {narrow && (
        <>
          <ArtifactStatusControl item={item} />
          <NameLink href={href} text={item.data.name} />
        </>
      )}
      {!narrow && placementCard && (
        <>
          <ArtifactStatusControl item={item} />
          <div className="flex w-full min-w-0 items-center">
            <IndentSpacer depth={indentDepth} />
            <DisplayableSlug
              placementSlug={placementSlug}
              slug={item.data.slug}
            />
            <NameLink
              disableNativeDrag={placementSlug}
              href={href}
              text={item.data.name}
            />
          </div>
        </>
      )}
      {!(narrow || placementCard) && (
        <>
          <DisplayableSlug
            placementSlug={placementSlug}
            slug={item.data.slug}
          />
          <ArtifactStatusControl item={item} />
          <NameLink
            disableNativeDrag={placementSlug}
            href={href}
            text={item.data.name}
          />
        </>
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

function LegacyArtifactNameCellStatus({
  item,
  sessionDisplayedStatus,
}: {
  item: Extract<DocumentRowItem, { kind: "branch" | "session" }>;
  sessionDisplayedStatus?: DisplayedSessionStatus;
}) {
  const rowTypeConfig = getRowTypeConfig(item, { sessionDisplayedStatus });
  const mappedStatusIcon = rowTypeConfig?.statusIcon ?? "in-progress";
  const statusLabel = rowTypeConfig?.statusLabel;
  const statusDescription = rowTypeConfig?.statusDescription;
  const failedStatusIconEnabled = useFeatureFlagEnabledOptional(
    FAILED_SESSION_STATUS_ICON_FEATURE_FLAG_KEY
  );
  const statusIcon =
    mappedStatusIcon === "failed" && !failedStatusIconEnabled
      ? "wont-do"
      : mappedStatusIcon;
  const statusAccessibleName =
    statusLabel && statusDescription
      ? `${statusLabel}, ${statusDescription}`
      : statusLabel;
  const statusTooltip =
    statusLabel && statusDescription
      ? `${statusLabel}. ${statusDescription}`
      : statusLabel;

  return (
    <ArtifactStatusTooltip label={statusTooltip}>
      {statusDescription ? (
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
        >
          <StatusDash label={statusAccessibleName ?? ""} size={16} />
        </button>
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <StatusIcon
            {...(statusLabel ? { "aria-label": statusLabel } : {})}
            size={16}
            status={statusIcon}
          />
        </div>
      )}
    </ArtifactStatusTooltip>
  );
}

function DisplayableSlug({
  slug,
  className,
  placementSlug = false,
}: {
  slug: string | null | undefined;
  className?: string;
  placementSlug?: boolean;
}) {
  const displayable = isDisplayableSlug(slug);
  if (!(displayable || placementSlug)) {
    return null;
  }
  return (
    <span
      aria-hidden={displayable ? undefined : true}
      className={cn(
        "mr-1.5 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs",
        placementSlug && "w-20 truncate",
        className
      )}
    >
      {displayable ? slug : null}
    </span>
  );
}

// ISS-11412: `TableGridHeaderV2` opens its select-all slot at the lead cell's
// `pl-3`, so a row that renders its selection slot opens it at the same inset
// and the two `size-7` slots centre their checkboxes on one x. Scoped to
// selectable rows so the Projects list, whose slug already sits under the Name
// label at `pl-2`, does not move. A host passing `px-0` still overrides it.
const SELECTABLE_NAME_CELL_INSET_CLASS_NAME = "pl-3";
