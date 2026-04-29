"use client";

import type { Priority } from "@repo/api/src/types/common";
import type {
  DocumentStatus,
  DocumentWithWorkstream,
} from "@repo/api/src/types/document";
import {
  DOCUMENT_STATUS_OPTIONS,
  DocumentType,
} from "@repo/api/src/types/document";
import type { JudgeFeedbackItem } from "@repo/api/src/types/evaluation";
import type {
  LoopSummariesResponse,
  LoopSummary,
  LoopSummaryEntry,
  LoopWithUser,
} from "@repo/api/src/types/loop";
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
import type { UseQueryResult } from "@tanstack/react-query";
import {
  CalendarIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloudIcon,
  EllipsisIcon,
  Loader2Icon,
  MonitorIcon,
  XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { MouseEvent } from "react";
import { createContext, useContext } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import {
  usePlanJudgesFeedback,
  usePrdJudgesFeedback,
} from "@/hooks/queries/use-judges";
import type { DocumentColumn } from "@/hooks/use-column-visibility";
import { DocumentColumn as Col } from "@/hooks/use-column-visibility";
import {
  ensureDate,
  formatDateCompact,
  formatRelativeTime,
} from "@/lib/date-utils";
import { getDocumentRoute, getFeatureRoute } from "@/lib/document-navigation";
import { deriveScoreDisplay } from "@/lib/evaluation-utils";
import { getCommandLabels, terminalLabel } from "@/lib/loop-display";
import {
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUS_TO_ICON,
  DOCUMENT_TYPE_BADGE_LABELS,
  DOCUMENT_TYPE_COLORS,
  PRIORITY_LABELS,
} from "@/lib/project-constants";
import { getUserDisplayName } from "@/lib/user-utils";

// ---- Unified row item type ----

export type DocumentRowItem =
  | { kind: "artifact"; data: DocumentWithWorkstream }
  | { kind: "feature"; data: DocumentWithWorkstream }
  | { kind: "project"; data: ProjectWithDetails };

// ---- Edit handlers context ----

export type RowEditHandlers = {
  onUpdateAssignee?: (itemId: string, assigneeId: string | null) => void;
  onUpdatePriority?: (itemId: string, priority: Priority) => void;
  onUpdateDueDate?: (itemId: string, date: Date | null) => void;
  onUpdateStatus?: (itemId: string, status: DocumentStatus) => void;
  /** Team members for the UserSelectPopover. */
  teamMembers?: User[];
  /** Active loops for displaying per-artifact loop status. */
  activeLoops?: LoopWithUser[];
  /** Parent entity title, injected per-row for the Parent column cell. */
  parentTitle?: string;
  /** Parent entity route, injected per-row for the Parent column cell. */
  parentHref?: string | null;
  /** Selects which LoopCell variant to render. Default = legacy behavior. */
  loopVariant?: "team" | "my-tasks";
  /** Per-document loop summaries (recursive descendant aggregation). */
  loopSummaries?: LoopSummariesResponse;
};

export const RowEditContext = createContext<RowEditHandlers>({});

// ---- Cell renderers ----

function NameCell({
  item,
  showCheckbox,
  isSelected,
  onSelectionChange,
  isExpanded,
  onToggleExpand,
  indented,
  href,
}: {
  item: DocumentRowItem;
  showCheckbox: boolean;
  isSelected: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  indented?: boolean;
  href?: string | null;
}) {
  const hasChevron = isExpanded !== undefined;
  const { onUpdateStatus } = useContext(RowEditContext);

  // Project rows: folder icon + optional slug + name
  if (item.kind === "project") {
    const className =
      "flex h-full w-full min-w-0 items-center overflow-hidden pr-3 pl-3";

    return (
      <div className={className}>
        {showCheckbox && (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center">
            <Checkbox
              checked={isSelected}
              onCheckedChange={(checked) =>
                onSelectionChange?.(item.data.id, checked === true)
              }
            />
          </div>
        )}
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

  // Artifact / feature rows: status icon + title (both are documents now)
  const statusIcon =
    DOCUMENT_STATUS_TO_ICON[item.data.status as DocumentStatus];

  const thinking =
    item.kind === "artifact" &&
    item.data.generationStatus != null &&
    ["PENDING", "QUEUED", "RUNNING"].includes(
      item.data.generationStatus.status
    );

  const statusLabels = DOCUMENT_STATUS_LABELS;
  const statusIcons = DOCUMENT_STATUS_TO_ICON;
  const statusOptions = DOCUMENT_STATUS_OPTIONS;

  const statusButton = (
    <button
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-muted"
      type="button"
    >
      <StatusIcon size={16} status={statusIcon} thinking={thinking} />
    </button>
  );

  const className =
    "flex h-full w-full min-w-0 items-center overflow-hidden pr-3 pl-3";

  return (
    <div className={className}>
      {showCheckbox && (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={(checked) =>
              onSelectionChange?.(item.data.id, checked === true)
            }
          />
        </div>
      )}
      {indented && <div className="w-7 shrink-0" />}
      {hasChevron && (
        <button
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
      )}
      <span className="mr-1.5 ml-1 inline-block min-w-[7ch] shrink-0 font-mono text-muted-foreground text-xs">
        {isDisplayableSlug(item.data.slug) ? item.data.slug : null}
      </span>
      {onUpdateStatus ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{statusButton}</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {statusOptions.map((value) => (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                  onUpdateStatus(item.data.id, value);
                }}
              >
                <StatusIcon
                  size={16}
                  status={statusIcons[value as keyof typeof statusIcons]}
                />
                {statusLabels[value as keyof typeof statusLabels]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <StatusIcon size={16} status={statusIcon} thinking={thinking} />
        </div>
      )}
      {href ? (
        <Link className="ml-1.5 min-w-0 flex-1" href={href} prefetch={false}>
          <TruncatedTitle text={item.data.title} />
        </Link>
      ) : (
        <div className="ml-1.5 min-w-0 flex-1">
          <TruncatedTitle text={item.data.title} />
        </div>
      )}
    </div>
  );
}

function TruncatedTitle({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block truncate font-medium text-base text-foreground">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

function TypeCell({ item }: { item: DocumentRowItem }) {
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
  const colors = DOCUMENT_TYPE_COLORS[item.data.type];
  const label = DOCUMENT_TYPE_BADGE_LABELS[item.data.type];
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <Badge className={`${colors.bg} ${colors.text}`} variant="secondary">
        {label}
      </Badge>
    </div>
  );
}

function ParentCell({ item: _item }: { item: DocumentRowItem }) {
  const { parentTitle, parentHref } = useContext(RowEditContext);

  if (parentTitle && parentHref) {
    return (
      <div className="h-11 w-[124px] shrink-0 border-l">
        <Link
          className="flex h-full w-full items-center px-3 py-2 hover:bg-muted/50"
          href={parentHref}
          onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
        >
          <span className="truncate font-medium text-muted-foreground text-xs">
            {parentTitle}
          </span>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <span className="truncate font-medium text-muted-foreground text-xs">
        {parentTitle ?? "\u2014"}
      </span>
    </div>
  );
}

function DueDateCell({ item }: { item: DocumentRowItem }) {
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

function AssigneeCell({ item }: { item: DocumentRowItem }) {
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

function PriorityCell({ item }: { item: DocumentRowItem }) {
  const { onUpdatePriority } = useContext(RowEditContext);
  const priority = item.data.priority ?? null;

  if (!onUpdatePriority) {
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

function ScoreCellDash() {
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <span className="font-medium text-muted-foreground text-xs">
        {"\u2014"}
      </span>
    </div>
  );
}

function ScoreCellFromFeedback({
  items,
}: {
  items: JudgeFeedbackItem[] | null | undefined;
}) {
  const score = deriveScoreDisplay(items);
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      {score !== null ? (
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

function ScoreCellWithQuery({
  queryResult,
}: {
  queryResult: UseQueryResult<JudgeFeedbackItem[] | null>;
}) {
  const { data, isLoading } = queryResult;
  if (isLoading) {
    return (
      <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
        <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <ScoreCellFromFeedback items={data ?? undefined} />;
}

function ScoreCell({ item }: { item: DocumentRowItem }) {
  const isPrd = item.kind === "artifact" && item.data.type === DocumentType.Prd;
  const isPlan =
    item.kind === "artifact" &&
    item.data.type === DocumentType.ImplementationPlan;
  const documentId = item.kind === "artifact" ? item.data.id : "";

  const prdJudgesQuery = usePrdJudgesFeedback(isPrd ? documentId : "");
  const planJudgesQuery = usePlanJudgesFeedback(isPlan ? documentId : "");

  if (item.kind !== "artifact") {
    return <ScoreCellDash />;
  }
  if (isPrd) {
    return <ScoreCellWithQuery queryResult={prdJudgesQuery} />;
  }
  if (isPlan) {
    return <ScoreCellWithQuery queryResult={planJudgesQuery} />;
  }
  return <ScoreCellDash />;
}

// ---- Loop cell base building blocks ----

const LOOP_CELL_BASE_CLASS =
  "flex h-11 w-[124px] shrink-0 items-center gap-1.5 border-l px-3 py-2";
const LOOP_CELL_LINK_CLASS = `${LOOP_CELL_BASE_CLASS} hover:bg-muted/50`;

function LoopCellDash() {
  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <span className="font-medium text-muted-foreground text-xs">—</span>
    </div>
  );
}

function LoopLink({
  loopId,
  children,
}: {
  loopId: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      className={LOOP_CELL_LINK_CLASS}
      href={`/loops/${loopId}`}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
    >
      {children}
    </Link>
  );
}

function LoopCellRunningContent({
  isLocal,
  label,
  labelMuted = true,
}: {
  isLocal: boolean;
  label: string;
  labelMuted?: boolean;
}) {
  const labelClass = labelMuted
    ? "truncate font-medium text-muted-foreground text-xs"
    : "truncate font-medium text-foreground text-xs";
  return (
    <>
      <Loader2Icon className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
      {isLocal ? (
        <MonitorIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <CloudIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className={labelClass}>{label}</span>
    </>
  );
}

function LoopCellCompletedContent({ label }: { label: string }) {
  return (
    <>
      <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-green-500" />
      <span className="truncate font-medium text-foreground text-xs">
        {label}
      </span>
    </>
  );
}

function LoopCellFailedContent({ label }: { label: string }) {
  return (
    <>
      <XCircleIcon className="h-3.5 w-3.5 shrink-0 text-red-500" />
      <span className="truncate font-medium text-red-500 text-xs">{label}</span>
    </>
  );
}

// ---- Default LoopCell (legacy behavior preserved) ----

function DefaultLoopCell({ item }: { item: DocumentRowItem }) {
  const { activeLoops } = useContext(RowEditContext);
  const documentId = item.data.id;

  const genStatus =
    item.kind === "artifact" ? item.data.generationStatus : undefined;
  const isFailed = genStatus?.status === "FAILURE";

  const loop = activeLoops?.find((l) => l.documentId === documentId);

  if (isFailed) {
    const failedLoopId = genStatus?.loopId;
    const content = <LoopCellFailedContent label="Loop Failed" />;
    if (failedLoopId) {
      return <LoopLink loopId={failedLoopId}>{content}</LoopLink>;
    }
    return <div className={LOOP_CELL_BASE_CLASS}>{content}</div>;
  }

  if (!loop) {
    return <LoopCellDash />;
  }

  const isLocal = loop.computeTarget != null;
  const userName = getUserDisplayName(loop.user);
  return (
    <LoopLink loopId={loop.id}>
      <LoopCellRunningContent isLocal={isLocal} label={userName} />
    </LoopLink>
  );
}

// ---- Team variant ----
//
// Running state comes from activeLoops (existing scope: documentId-only, NOT
// recursive). This preserves existing Team View behavior — the running indicator
// matches the artifact you're looking at, not its children. Completed/failed
// state comes from loopSummaries (recursive scope).

function TeamLoopCell({ item }: { item: DocumentRowItem }) {
  const { activeLoops, loopSummaries } = useContext(RowEditContext);
  const documentId = item.data.id;

  const genStatus =
    item.kind === "artifact" ? item.data.generationStatus : undefined;
  const isFailedGen = genStatus?.status === "FAILURE";
  const directLoop = activeLoops?.find((l) => l.documentId === documentId);
  const summary = loopSummaries?.[documentId];

  // Direct active loop wins (existing Team View behavior).
  if (directLoop) {
    const userName = getUserDisplayName(directLoop.user);
    return (
      <LoopLink loopId={directLoop.id}>
        <LoopCellRunningContent
          isLocal={directLoop.computeTarget != null}
          label={userName}
        />
      </LoopLink>
    );
  }

  // Failed-newer-than-active priority. Active is null here, but check failed
  // before completed regardless: failures should surface aggressively.
  if (summary?.latestFailed) {
    const f = summary.latestFailed;
    return (
      <LoopLink loopId={f.loopId}>
        <LoopCellFailedContent label={terminalLabel(f.status, f.command)} />
      </LoopLink>
    );
  }

  if (isFailedGen) {
    const failedLoopId = genStatus?.loopId;
    const content = <LoopCellFailedContent label="Loop Failed" />;
    return failedLoopId ? (
      <LoopLink loopId={failedLoopId}>{content}</LoopLink>
    ) : (
      <div className={LOOP_CELL_BASE_CLASS}>{content}</div>
    );
  }

  if (summary?.latestCompleted) {
    const c = summary.latestCompleted;
    const userName = c.userName;
    const relativeTime = c.completedAt
      ? formatRelativeTime(c.completedAt)
      : null;
    const label = relativeTime ? `${userName} · ${relativeTime}` : userName;
    return (
      <LoopLink loopId={c.loopId}>
        <LoopCellCompletedContent label={label} />
      </LoopLink>
    );
  }

  return <LoopCellDash />;
}

// ---- My Tasks variant ----
//
// Reads exclusively from loopSummaries. Apply full priority logic:
// 1. failed-newer-than-active wins
// 2. else active
// 3. else failed
// 4. else completed
// 5. else dash

function pickMyTasksEntry(summary: LoopSummary): {
  kind: "active" | "failed" | "completed";
  entry: LoopSummaryEntry;
} | null {
  const { activeLoop, latestFailed, latestCompleted } = summary;
  if (latestFailed && activeLoop) {
    const failedTs = latestFailed.failedAt
      ? Date.parse(latestFailed.failedAt)
      : 0;
    const activeStarted = activeLoop.startedAt
      ? Date.parse(activeLoop.startedAt)
      : 0;
    if (failedTs > activeStarted) {
      return { kind: "failed", entry: latestFailed };
    }
  }
  if (activeLoop) {
    return { kind: "active", entry: activeLoop };
  }
  if (latestFailed) {
    return { kind: "failed", entry: latestFailed };
  }
  if (latestCompleted) {
    return { kind: "completed", entry: latestCompleted };
  }
  return null;
}

function MyTasksLoopCell({ item }: { item: DocumentRowItem }) {
  const { loopSummaries } = useContext(RowEditContext);
  const summary = loopSummaries?.[item.data.id];

  if (!summary) {
    return <LoopCellDash />;
  }

  const picked = pickMyTasksEntry(summary);
  if (!picked) {
    return <LoopCellDash />;
  }

  const { kind, entry } = picked;
  if (kind === "active") {
    const labels = getCommandLabels(entry.command);
    return (
      <LoopLink loopId={entry.loopId}>
        <LoopCellRunningContent
          isLocal={entry.isLocal}
          label={labels.progress}
          labelMuted={false}
        />
      </LoopLink>
    );
  }
  if (kind === "failed") {
    return (
      <LoopLink loopId={entry.loopId}>
        <LoopCellFailedContent
          label={terminalLabel(entry.status, entry.command)}
        />
      </LoopLink>
    );
  }
  // completed
  return (
    <LoopLink loopId={entry.loopId}>
      <LoopCellCompletedContent
        label={getCommandLabels(entry.command).completed}
      />
    </LoopLink>
  );
}

// ---- LoopCell dispatcher ----

function LoopCell({ item }: { item: DocumentRowItem }) {
  const { loopVariant } = useContext(RowEditContext);
  if (loopVariant === "team") {
    return <TeamLoopCell item={item} />;
  }
  if (loopVariant === "my-tasks") {
    return <MyTasksLoopCell item={item} />;
  }
  return <DefaultLoopCell item={item} />;
}

function ProjectCell({ item }: { item: DocumentRowItem }) {
  let project: {
    id: string;
    name: string;
    teams?: { id: string; name: string }[];
  } | null = null;

  if (item.kind === "project") {
    project = item.data;
  } else if (item.data.project) {
    project = {
      id: item.data.project.id,
      name: item.data.project.name,
      teams: item.data.project.teams,
    };
  }

  const projectName = project?.name ?? null;
  const teamId = project?.teams?.[0]?.id;
  const projectHref =
    teamId && project?.id ? `/teams/${teamId}/projects/${project.id}` : null;

  if (projectName && projectHref) {
    return (
      <div className="h-11 w-[124px] shrink-0 border-l">
        <Link
          className="flex h-full w-full items-center px-3 py-2 hover:bg-muted/50"
          href={projectHref}
          onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
        >
          <span className="truncate font-medium text-muted-foreground text-xs">
            {projectName}
          </span>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-11 w-[124px] shrink-0 items-center border-l px-3 py-2">
      <span className="truncate font-medium text-muted-foreground text-xs">
        {projectName ?? "\u2014"}
      </span>
    </div>
  );
}

function UpdatedCell({ item }: { item: DocumentRowItem }) {
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
  DocumentColumn,
  React.ComponentType<{ item: DocumentRowItem }>
> = {
  [Col.Type]: TypeCell,
  [Col.Parent]: ParentCell,
  [Col.DueDate]: DueDateCell,
  [Col.Assignee]: AssigneeCell,
  [Col.Priority]: PriorityCell,
  [Col.Score]: ScoreCell,
  [Col.Loop]: LoopCell,
  [Col.Updated]: UpdatedCell,
  [Col.Project]: ProjectCell,
};

// ---- Main row component ----

type DocumentRowProps = {
  item: DocumentRowItem;
  visibleColumns: DocumentColumn[];
  showCheckbox?: boolean;
  isSelected?: boolean;
  onSelectionChange?: (id: string, checked: boolean) => void;
  onMoreMenu?: (item: DocumentRowItem, anchor: HTMLElement) => void;
  /** Custom content for the more menu cell (replaces the default ellipsis button). */
  moreMenuContent?: React.ReactNode;
  /** When defined, renders a chevron for expand/collapse (grouped "All" view). */
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  /** When true, indents the name cell to align with parent rows that have a chevron. */
  indented?: boolean;
  /** Edit handlers for inline cell editing. */
  editHandlers?: RowEditHandlers;
  /** Parent entity title for this row, used by the Parent column cell. */
  parentTitle?: string;
  /** Parent entity route for this row, used by the Parent column cell. */
  parentHref?: string | null;
  /** Extend an indented bottom border to the left edge. */
  extendIndentedBottomBorderLeft?: boolean;
};

export function DocumentRow({
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
  parentTitle,
  parentHref,
  extendIndentedBottomBorderLeft = false,
}: DocumentRowProps) {
  const params = useParams();
  const activeTeamId = params?.teamId as string | undefined;

  const gridTemplateColumns = getDocumentRowGridTemplateColumns(
    visibleColumns.length
  );
  const useIndentedBottomBorder = indented || isExpanded === true;

  function computeHref(): string | null {
    if (item.kind === "project") {
      const teamId = activeTeamId ?? item.data.teams[0]?.id;
      return teamId ? `/teams/${teamId}/projects/${item.data.id}` : null;
    }
    if (item.kind === "feature") {
      return getFeatureRoute(item.data);
    }
    return getDocumentRoute(item.data);
  }

  const href = computeHref();

  return (
    <RowEditContext.Provider
      value={{ ...(editHandlers ?? {}), parentHref, parentTitle }}
    >
      <div
        className={`group/row relative grid h-11 min-w-fit ${isSelected ? "bg-accent/40 hover:bg-accent/60" : "bg-background hover:bg-muted/40"}`}
        style={{ gridTemplateColumns }}
      >
        {useIndentedBottomBorder ? (
          <>
            <div className="pointer-events-none absolute right-0 bottom-0 left-10 border-b" />
            {extendIndentedBottomBorderLeft && (
              <div className="pointer-events-none absolute bottom-0 left-0 h-px w-10 bg-border" />
            )}
          </>
        ) : (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 border-b" />
        )}
        <div>
          <NameCell
            href={href}
            indented={indented}
            isExpanded={isExpanded}
            isSelected={isSelected}
            item={item}
            onSelectionChange={onSelectionChange}
            onToggleExpand={onToggleExpand}
            showCheckbox={showCheckbox}
          />
        </div>

        {visibleColumns.map((column) => {
          const CellRenderer = CELL_RENDERERS[column];
          return (
            <div key={column}>
              <CellRenderer item={item} />
            </div>
          );
        })}

        {/* More menu */}
        <div>
          <div className="flex h-11 items-center border-l px-3 py-2">
            {moreMenuContent ?? (
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
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
      </div>
    </RowEditContext.Provider>
  );
}

export function getDocumentRowGridTemplateColumns(
  visibleColumnCount: number
): string {
  return [
    "minmax(350px, 1fr)",
    ...Array.from({ length: visibleColumnCount }, () => "124px"),
    "56px",
  ].join(" ");
}
