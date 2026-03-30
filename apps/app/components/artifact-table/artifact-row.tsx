"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import type { Priority } from "@repo/api/src/types/common";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import type { LoopWithUser } from "@repo/api/src/types/loop";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Checkbox } from "@repo/design-system/components/ui/checkbox";
import { DatePickerPopover } from "@repo/design-system/components/ui/date-picker-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { StatusPercentageIcon } from "@repo/design-system/components/ui/status-percentage-icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { User } from "@repo/design-system/components/ui/user-select-popover";
import { UserSelectPopover } from "@repo/design-system/components/ui/user-select-popover";
import {
  CalendarIcon,
  ChevronRightIcon,
  CloudIcon,
  EllipsisIcon,
  Loader2Icon,
  MonitorIcon,
  NetworkIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import type { ArtifactColumn } from "@/hooks/use-column-visibility";
import { ArtifactColumn as Col } from "@/hooks/use-column-visibility";
import {
  getArtifactRoute,
  getFeatureRoute,
  isNavigableArtifact,
} from "@/lib/artifact-navigation";
import {
  ensureDate,
  formatDateCompact,
  formatRelativeTime,
} from "@/lib/date-utils";
import {
  ARTIFACT_STATUS_LABELS,
  ARTIFACT_STATUS_TO_ICON,
  ARTIFACT_TYPE_BADGE_LABELS,
  ARTIFACT_TYPE_COLORS,
  FEATURE_STATUS_LABELS,
  FEATURE_STATUS_TO_ICON,
  PRIORITY_LABELS,
} from "@/lib/project-constants";
import { getUserDisplayName } from "@/lib/user-utils";

// ---- Unified row item type ----

export type ArtifactRowItem =
  | { kind: "artifact"; data: ArtifactWithWorkstream }
  | { kind: "feature"; data: FeatureWithWorkstream }
  | { kind: "project"; data: ProjectWithDetails };

// ---- Edit handlers context ----

export type RowEditHandlers = {
  onUpdateAssignee?: (itemId: string, assigneeId: string | null) => void;
  onUpdatePriority?: (itemId: string, priority: Priority) => void;
  onUpdateDueDate?: (itemId: string, date: Date | null) => void;
  onUpdateStatus?: (itemId: string, status: string) => void;
  /** Team members for the UserSelectPopover. */
  teamMembers?: User[];
  /** Active loops for displaying per-artifact loop status. */
  activeLoops?: LoopWithUser[];
};

const RowEditContext = createContext<RowEditHandlers>({});

// ---- Cell renderers ----

function NameCell({
  item,
  showCheckbox,
  isSelected,
  onSelectionChange,
  isExpanded,
  onToggleExpand,
  indented,
  onNavigate,
}: {
  item: ArtifactRowItem;
  showCheckbox: boolean;
  isSelected: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  indented?: boolean;
  onNavigate?: () => void;
}) {
  const hasChevron = isExpanded !== undefined;
  const { onUpdateStatus } = useContext(RowEditContext);

  // Project rows: folder icon + optional slug + name
  if (item.kind === "project") {
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav handled by inner elements
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: clickable name cell for navigation
      // biome-ignore lint/a11y/noStaticElementInteractions: clickable name cell
      <div
        className={`flex min-w-[250px] flex-1 items-center pr-3 pl-3 ${onNavigate ? "cursor-pointer" : ""}`}
        onClick={onNavigate}
      >
        {showCheckbox && (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center">
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) =>
                onSelectionChange?.(item.data.id, checked === true)
              }
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}
        <span className="ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
          {isDisplayableSlug(item.data.slug) ? item.data.slug : null}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: stop propagation only, no interactive action */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: stop propagation only */}
            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: stop propagation only */}
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center"
              onClick={(e) => e.stopPropagation()}
            >
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
        <span className="ml-1.5 truncate font-medium text-base text-foreground">
          {item.data.name}
        </span>
      </div>
    );
  }

  // Artifact / feature rows: status icon + title
  const statusIcon =
    item.kind === "artifact"
      ? ARTIFACT_STATUS_TO_ICON[item.data.status as ArtifactStatus]
      : FEATURE_STATUS_TO_ICON[item.data.status];

  const thinking =
    item.kind === "artifact" &&
    item.data.generationStatus != null &&
    ["PENDING", "QUEUED", "RUNNING"].includes(
      item.data.generationStatus.status
    );

  const statusOptions =
    item.kind === "artifact"
      ? { labels: ARTIFACT_STATUS_LABELS, icons: ARTIFACT_STATUS_TO_ICON }
      : { labels: FEATURE_STATUS_LABELS, icons: FEATURE_STATUS_TO_ICON };

  const statusButton = (
    <button
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-accent"
      onClick={(e) => e.stopPropagation()}
      type="button"
    >
      <StatusIcon size={16} status={statusIcon} thinking={thinking} />
    </button>
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav handled by inner elements
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: clickable name cell for navigation
    // biome-ignore lint/a11y/noStaticElementInteractions: clickable name cell
    <div
      className={`flex min-w-[250px] flex-1 items-center pr-3 pl-3 ${onNavigate ? "cursor-pointer" : ""}`}
      onClick={onNavigate}
    >
      {showCheckbox && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) =>
              onSelectionChange?.(item.data.id, checked === true)
            }
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
      {indented && <div className="w-7 shrink-0" />}
      {hasChevron && (
        <button
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${onToggleExpand ? "hover:bg-accent" : "cursor-default opacity-30"}`}
          onClick={(e) => {
            e.stopPropagation();
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
      )}
      <span className="ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {isDisplayableSlug(item.data.slug) ? item.data.slug : null}
      </span>
      {onUpdateStatus ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{statusButton}</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {Object.entries(statusOptions.labels).map(([value, label]) => (
              <DropdownMenuItem
                className="hover:!bg-accent focus:!bg-accent data-[highlighted]:!bg-accent"
                key={value}
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdateStatus(item.data.id, value);
                }}
              >
                <StatusIcon
                  size={16}
                  status={
                    statusOptions.icons[
                      value as keyof typeof statusOptions.icons
                    ]
                  }
                />
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <StatusIcon size={16} status={statusIcon} thinking={thinking} />
        </div>
      )}
      <span className="ml-1.5 truncate font-medium text-base text-foreground">
        {item.data.title}
      </span>
    </div>
  );
}

function TypeCell({ item }: { item: ArtifactRowItem }) {
  if (item.kind === "project") {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2" />
    );
  }
  if (item.kind === "feature") {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
        <Badge
          className="bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300"
          variant="secondary"
        >
          Feature
        </Badge>
      </div>
    );
  }
  const colors = ARTIFACT_TYPE_COLORS[item.data.type];
  const label = ARTIFACT_TYPE_BADGE_LABELS[item.data.type];
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <Badge className={`${colors.bg} ${colors.text}`} variant="secondary">
        {label}
      </Badge>
    </div>
  );
}

function WorkflowCell({ item }: { item: ArtifactRowItem }) {
  const workstream =
    item.kind === "artifact" ? item.data.workstream : undefined;
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-l px-3 py-2">
      <NetworkIcon className="mr-1 h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-muted-foreground text-xs">
        {workstream?.title ?? "\u2014"}
      </span>
    </div>
  );
}

function DueDateCell({ item }: { item: ArtifactRowItem }) {
  const { onUpdateDueDate } = useContext(RowEditContext);
  // Projects use targetDate; artifacts/features use updatedAt as a placeholder
  const date =
    item.kind === "project"
      ? ensureDate(item.data.targetDate)
      : ensureDate(item.data.updatedAt);

  const trigger = (
    <button
      className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-l px-3 py-2 hover:bg-muted/50"
      onClick={(e) => e.stopPropagation()}
      type="button"
    >
      <div className="flex w-8 shrink-0 items-center justify-center py-2">
        <CalendarIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <span className="truncate font-medium text-muted-foreground text-xs">
        {date ? formatDateCompact(date) : "\u2014"}
      </span>
    </button>
  );

  if (!onUpdateDueDate) {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-l px-3 py-2">
        <div className="flex w-8 shrink-0 items-center justify-center py-2">
          <CalendarIcon className="h-4 w-4 text-muted-foreground" />
        </div>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {date ? formatDateCompact(date) : "\u2014"}
        </span>
      </div>
    );
  }

  return (
    <DatePickerPopover
      onSelect={(d) => onUpdateDueDate(item.data.id, d)}
      trigger={trigger}
      value={date}
    />
  );
}

function AssigneeCell({ item }: { item: ArtifactRowItem }) {
  const { onUpdateAssignee, teamMembers } = useContext(RowEditContext);
  const assignee = item.data.assignee ?? null;

  const trigger = (
    <button
      className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-l px-3 py-2 hover:bg-muted/50"
      onClick={(e) => e.stopPropagation()}
      type="button"
    >
      <div className="flex shrink-0 items-center justify-center p-1.5">
        <AssigneeAvatar
          assignee={assignee}
          className="size-5"
          disableLink
          disableTooltip
        />
      </div>
      {assignee && (
        <span className="truncate font-medium text-muted-foreground text-xs">
          {assignee.firstName} {assignee.lastName}
        </span>
      )}
    </button>
  );

  if (!(onUpdateAssignee && teamMembers)) {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-l px-3 py-2">
        <div className="flex shrink-0 items-center justify-center p-1.5">
          <AssigneeAvatar
            assignee={assignee}
            className="size-5"
            disableLink
            disableTooltip
          />
        </div>
        {assignee && (
          <span className="truncate font-medium text-muted-foreground text-xs">
            {assignee.firstName} {assignee.lastName}
          </span>
        )}
      </div>
    );
  }

  return (
    <UserSelectPopover
      onSelect={(user) => onUpdateAssignee(item.data.id, user?.id ?? null)}
      trigger={trigger}
      users={teamMembers}
      value={
        assignee
          ? {
              id: assignee.id,
              name: getUserDisplayName(assignee),
              avatarUrl: assignee.avatarUrl || undefined,
            }
          : null
      }
    />
  );
}

function PriorityCell({ item }: { item: ArtifactRowItem }) {
  const { onUpdatePriority } = useContext(RowEditContext);
  // Features and projects have priority; artifacts show a static dash
  const priority =
    item.kind === "feature" || item.kind === "project"
      ? item.data.priority
      : null;

  if (!onUpdatePriority || item.kind === "artifact") {
    if (!priority) {
      return (
        <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
          <span className="font-medium text-muted-foreground text-xs">—</span>
        </div>
      );
    }
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-l px-3 py-2">
        <div className="flex shrink-0 items-center p-2">
          <PriorityIcon priority={priority} />
        </div>
        <span className="truncate font-medium text-muted-foreground text-xs">
          {PRIORITY_LABELS[priority]}
        </span>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-11 w-[124px] shrink-0 items-center gap-0 border-l px-3 py-2 hover:bg-muted/50"
          onClick={(e) => e.stopPropagation()}
          type="button"
        >
          {priority ? (
            <>
              <div className="flex shrink-0 items-center p-2">
                <PriorityIcon priority={priority} />
              </div>
              <span className="truncate font-medium text-muted-foreground text-xs">
                {PRIORITY_LABELS[priority]}
              </span>
            </>
          ) : (
            <span className="font-medium text-muted-foreground text-xs">—</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
          <DropdownMenuItem
            className="hover:!bg-accent focus:!bg-accent data-[highlighted]:!bg-accent"
            key={value}
            onClick={(e) => {
              e.stopPropagation();
              onUpdatePriority(item.data.id, value as Priority);
            }}
          >
            <PriorityIcon priority={value as Priority} />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ScoreCell({ item }: { item: ArtifactRowItem }) {
  const score =
    item.kind === "artifact"
      ? item.data.customFields?.find(
          (f) => f.name.toLowerCase() === "quality score"
        )?.displayValue
      : undefined;

  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      {score ? (
        <span className="truncate font-medium text-green-600 text-xs dark:text-green-400">
          {score}
        </span>
      ) : (
        <span className="font-medium text-muted-foreground text-xs">
          {"\u2014"}
        </span>
      )}
    </div>
  );
}

function LoopCell({ item }: { item: ArtifactRowItem }) {
  const { activeLoops } = useContext(RowEditContext);
  const artifactId = item.data.id;

  const genStatus =
    item.kind === "artifact" ? item.data.generationStatus : undefined;
  const isFailed = genStatus?.status === "FAILURE";

  const loop = activeLoops?.find((l) => l.artifactId === artifactId);

  if (isFailed) {
    const failedLoopId = genStatus?.loopId;
    const cellContent = (
      <>
        <XCircleIcon className="h-3.5 w-3.5 shrink-0 text-red-500" />
        <span className="truncate font-medium text-red-500 text-xs">
          Loop Failed
        </span>
      </>
    );
    if (failedLoopId) {
      return (
        <Link
          className="flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-l px-3 py-2 hover:bg-muted/50"
          href={`/loops/${failedLoopId}`}
          onClick={(e) => e.stopPropagation()}
        >
          {cellContent}
        </Link>
      );
    }
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-l px-3 py-2">
        {cellContent}
      </div>
    );
  }

  if (!loop) {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
        <span className="font-medium text-muted-foreground text-xs">—</span>
      </div>
    );
  }

  const isLocal = loop.computeTarget != null;
  const userName = getUserDisplayName(loop.user);

  return (
    <Link
      className="flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-l px-3 py-2 hover:bg-muted/50"
      href={`/loops/${loop.id}`}
      onClick={(e) => e.stopPropagation()}
    >
      <Loader2Icon className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
      {isLocal ? (
        <MonitorIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <CloudIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="truncate font-medium text-muted-foreground text-xs">
        {userName}
      </span>
    </Link>
  );
}

function ProjectCell({ item }: { item: ArtifactRowItem }) {
  const projectName =
    item.kind === "project" ? item.data.name : item.data.project?.name;
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <span className="truncate font-medium text-muted-foreground text-xs">
        {projectName ?? "\u2014"}
      </span>
    </div>
  );
}

function UpdatedCell({ item }: { item: ArtifactRowItem }) {
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <span className="truncate font-medium text-muted-foreground text-xs">
        {formatRelativeTime(item.data.updatedAt)}
      </span>
    </div>
  );
}

// ---- Column to cell mapping ----

const CELL_RENDERERS: Record<
  ArtifactColumn,
  React.ComponentType<{ item: ArtifactRowItem }>
> = {
  [Col.Type]: TypeCell,
  [Col.Workflow]: WorkflowCell,
  [Col.DueDate]: DueDateCell,
  [Col.Assignee]: AssigneeCell,
  [Col.Priority]: PriorityCell,
  [Col.Score]: ScoreCell,
  [Col.Loop]: LoopCell,
  [Col.Updated]: UpdatedCell,
  [Col.Project]: ProjectCell,
};

// ---- Main row component ----

type ArtifactRowProps = {
  item: ArtifactRowItem;
  visibleColumns: ArtifactColumn[];
  showCheckbox?: boolean;
  isSelected?: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
  onMoreMenu?: (item: ArtifactRowItem, anchor: HTMLElement) => void;
  /** Custom content for the more menu cell (replaces the default ellipsis button). */
  moreMenuContent?: React.ReactNode;
  /** When defined, renders a chevron for expand/collapse (grouped "All" view). */
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /** When true, indents the name cell to align with parent rows that have a chevron. */
  indented?: boolean;
  /** Edit handlers for inline cell editing. */
  editHandlers?: RowEditHandlers;
};

export function ArtifactRow({
  item,
  visibleColumns,
  showCheckbox = false,
  isSelected = false,
  onSelectionChange,
  onMoreMenu,
  moreMenuContent,
  isExpanded,
  onToggleExpand,
  indented = false,
  editHandlers,
}: ArtifactRowProps) {
  const router = useRouter();

  const isClickable =
    item.kind === "project" ||
    item.kind === "feature" ||
    (item.kind === "artifact" && isNavigableArtifact(item.data));

  function handleClick() {
    if (item.kind === "project") {
      const teamId = item.data.teams[0]?.id;
      if (teamId) {
        router.push(`/teams/${teamId}/projects/${item.data.id}`);
      }
      return;
    }
    if (item.kind === "artifact") {
      const route = getArtifactRoute(item.data);
      if (route) {
        router.push(route);
      }
    } else {
      router.push(getFeatureRoute(item.data));
    }
  }

  return (
    <RowEditContext.Provider value={editHandlers ?? {}}>
      <div className="group/row flex h-11 min-w-fit items-center border-b bg-background hover:bg-muted/50">
        <NameCell
          indented={indented}
          isExpanded={isExpanded}
          isSelected={isSelected}
          item={item}
          onNavigate={isClickable ? handleClick : undefined}
          onSelectionChange={onSelectionChange}
          onToggleExpand={onToggleExpand}
          showCheckbox={showCheckbox}
        />

        {visibleColumns.map((column) => {
          const CellRenderer = CELL_RENDERERS[column];
          return <CellRenderer item={item} key={column} />;
        })}

        {/* More menu */}
        <div className="flex h-11 w-14 shrink-0 items-center border-l px-3 py-2">
          {moreMenuContent ?? (
            <button
              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation();
                onMoreMenu?.(item, e.currentTarget);
              }}
              type="button"
            >
              <EllipsisIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </RowEditContext.Provider>
  );
}
