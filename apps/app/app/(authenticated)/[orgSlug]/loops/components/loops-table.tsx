"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import type { LoopWithUser } from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { ConfirmStopLoopDialog } from "@repo/app/loops/components/confirm-stop-loop-dialog";
import { LoopStatusBadge } from "@repo/app/loops/components/loop-status-badge";
import { useLoops, useResumeLoop } from "@repo/app/loops/hooks/use-loops";
import {
  CANCELLABLE_LOOP_STATUSES,
  RESTARTABLE_LOOP_STATUSES,
} from "@repo/app/loops/lib/loop-constants";
import { getErrorMessage } from "@repo/app/shared/api/api-error";
import { LoopCommandBadge } from "@repo/app/shared/components/status-badge";
import { UserLink } from "@repo/app/shared/components/user-link";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  formatDuration,
  formatTokenCount,
} from "@repo/app/shared/lib/format-utils";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import { TagChips } from "@repo/app/tags/components/tag-chip";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type Column,
  DataTable,
} from "@repo/design-system/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { FilterChip } from "@repo/design-system/components/ui/filter-chip";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { useNavigation } from "@repo/navigation/use-navigation";
import {
  CloudIcon,
  FilterIcon,
  Loader2Icon,
  MonitorIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useCancelLoop } from "@/hooks/queries/use-loops";
import { useOrgSlug } from "@/hooks/use-org-slug";

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total === 0) {
    return "-";
  }
  return formatTokenCount(total);
}

function ComputeTargetCell({ loop }: Readonly<{ loop: LoopWithUser }>) {
  if (loop.computeTarget) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
        <MonitorIcon className="h-3.5 w-3.5" />
        <span>{loop.computeTarget.machineName}</span>
      </span>
    );
  }
  if (loop.containerId) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
        <CloudIcon className="h-3.5 w-3.5" />
        <span>Cloud</span>
      </span>
    );
  }
  return <span className="text-muted-foreground text-sm">-</span>;
}

function toggleSetValue<T extends string>(
  set: Set<T>,
  value: T,
  add: boolean
): Set<T> {
  const next = new Set(set);
  if (add) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return next;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200];

const columns: Column<LoopWithUser>[] = [
  {
    key: "status",
    header: "Status",
    sortable: true,
    render: (loop) => <LoopStatusBadge status={loop.status} />,
  },
  {
    key: "command",
    header: "Command",
    sortable: true,
    render: (loop) => <LoopCommandBadge command={loop.command} />,
  },
  {
    key: "prompt",
    header: "Prompt",
    render: (loop) => (
      <span className="line-clamp-1 max-w-[300px] text-sm">
        {loop.prompt || "-"}
      </span>
    ),
  },
  {
    key: "user",
    header: "User",
    render: (loop) => (
      <UserLink
        className="text-muted-foreground text-sm hover:underline"
        userId={loop.user.id}
      >
        {getUserDisplayName(loop.user)}
      </UserLink>
    ),
  },
  {
    key: "computeTargetId",
    header: "Target",
    render: (loop) => <ComputeTargetCell loop={loop} />,
  },
  {
    key: "createdAt",
    header: "Created",
    sortable: true,
    render: (loop) => (
      <span className="text-muted-foreground text-sm">
        {formatRelativeTime(loop.createdAt)}
      </span>
    ),
  },
  {
    key: "duration",
    header: "Duration",
    render: (loop) => (
      <span className="font-mono text-muted-foreground text-sm">
        {formatDuration(loop.startedAt, loop.completedAt)}
      </span>
    ),
  },
  {
    key: "tokens",
    header: "Tokens",
    sortable: true,
    render: (loop) => (
      <span className="font-mono text-muted-foreground text-sm">
        {formatTokens(loop.tokensInput, loop.tokensOutput)}
      </span>
    ),
  },
  {
    key: "tags",
    header: "Tags",
    render: (loop) => <TagChips maxVisible={2} tags={loop.tags ?? []} />,
  },
];

const COMMAND_OPTIONS = [
  { label: "Plan", value: LoopCommand.Plan },
  { label: "Execute", value: LoopCommand.Execute },
  { label: "Chat", value: LoopCommand.Chat },
  { label: "Explore", value: LoopCommand.Explore },
  { label: "Request Changes", value: LoopCommand.RequestChanges },
  { label: "Decompose", value: LoopCommand.Decompose },
  { label: "Generate PRD", value: LoopCommand.GeneratePrd },
  { label: "Bootstrap", value: LoopCommand.Bootstrap },
];

const STATUS_OPTIONS = [
  { label: "Pending", value: LoopStatus.Pending },
  { label: "Blocked", value: LoopStatus.Blocked },
  { label: "Claimed", value: LoopStatus.Claimed },
  { label: "Running", value: LoopStatus.Running },
  { label: "Completed", value: LoopStatus.Completed },
  { label: "Failed", value: LoopStatus.Failed },
  { label: "Cancelled", value: LoopStatus.Cancelled },
  { label: "Timed Out", value: LoopStatus.TimedOut },
];

const COMMAND_LABELS = new Map<LoopCommand, string>(
  COMMAND_OPTIONS.map((option) => [option.value, option.label])
);

const STATUS_LABELS = new Map<LoopStatus, string>(
  STATUS_OPTIONS.map((option) => [option.value, option.label])
);

const DEFAULT_PAGE_SIZE = 10;

export function LoopsTable() {
  const navigation = useNavigation();
  const orgSlug = useOrgSlug();
  const tokensFlag = useFeatureFlag("the-one-flag");
  const explicitComputeSelectionEnabled = useFeatureFlagEnabled(
    EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY
  );
  const [pageSize, setPageSize] = useLocalStorageState(
    "loops:table:pageSize",
    DEFAULT_PAGE_SIZE
  );
  const [selectedCommands, setSelectedCommands] = useState<Set<LoopCommand>>(
    new Set()
  );
  const [selectedStatuses, setSelectedStatuses] = useState<Set<LoopStatus>>(
    new Set()
  );
  const [confirmCancelLoop, setConfirmCancelLoop] =
    useState<LoopWithUser | null>(null);
  const resumeLoop = useResumeLoop();
  const cancelLoop = useCancelLoop();
  const [pendingLoopId, setPendingLoopId] = useState<string | null>(null);
  const [cancellingLoopId, setCancellingLoopId] = useState<string | null>(null);

  const { data: loops = [], isLoading, error } = useLoops({ limit: 200 });

  const filteredLoops = useMemo(() => {
    let result = loops;
    if (selectedCommands.size > 0) {
      result = result.filter((loop) => selectedCommands.has(loop.command));
    }
    if (selectedStatuses.size > 0) {
      result = result.filter((loop) => selectedStatuses.has(loop.status));
    }
    return result;
  }, [loops, selectedCommands, selectedStatuses]);

  const activeFilterCount = selectedCommands.size + selectedStatuses.size;
  const activeCommandValues = useMemo(
    () => Array.from(selectedCommands),
    [selectedCommands]
  );
  const activeStatusValues = useMemo(
    () => Array.from(selectedStatuses),
    [selectedStatuses]
  );

  const handleRowClick = (loop: LoopWithUser) => {
    navigation.navigate(`/${orgSlug}/loops/${loop.id}`);
  };

  const handleRestart = async (loop: LoopWithUser) => {
    setPendingLoopId(loop.id);
    try {
      const result = await resumeLoop.mutateAsync({
        id: loop.id,
        ...(explicitComputeSelectionEnabled && loop.computeTarget?.id
          ? { computeTargetId: loop.computeTarget.id }
          : {}),
      });
      toast.success("Loop restarted");
      navigation.navigate(`/${orgSlug}/loops/${result.loopId}`);
    } catch (error) {
      toast.error("Loop restart failed", {
        description: getErrorMessage(error),
      });
    } finally {
      setPendingLoopId(null);
    }
  };

  const handleCancel = (loop: LoopWithUser) => {
    setCancellingLoopId(loop.id);
    cancelLoop.mutate(
      {
        id: loop.id,
        computeTargetId: loop.computeTarget?.id ?? null,
      },
      {
        onSuccess: () => {
          toast.success("Loop cancelled");
        },
        // The global QueryClient onError handler toasts the error.
        onSettled: () => {
          setCancellingLoopId(null);
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="error">
        <AlertDescription>
          {error.message ?? "Failed to load loops"}
        </AlertDescription>
      </Alert>
    );
  }

  const filteredColumns = tokensFlag?.enabled
    ? columns
    : columns.filter((column) => column.key !== "tokens");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <FilterIcon className="h-4 w-4" />
              Filter
              {activeFilterCount > 0 && (
                <span className="ml-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-primary-foreground text-xs">
                  {activeFilterCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Command</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {COMMAND_OPTIONS.map((opt) => (
                  <DropdownMenuCheckboxItem
                    checked={selectedCommands.has(opt.value)}
                    key={opt.value}
                    onCheckedChange={(checked) =>
                      setSelectedCommands((prev) =>
                        toggleSetValue(prev, opt.value, checked === true)
                      )
                    }
                    onSelect={(e) => e.preventDefault()}
                  >
                    {opt.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Status</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {STATUS_OPTIONS.map((opt) => (
                  <DropdownMenuCheckboxItem
                    checked={selectedStatuses.has(opt.value)}
                    key={opt.value}
                    onCheckedChange={(checked) =>
                      setSelectedStatuses((prev) =>
                        toggleSetValue(prev, opt.value, checked === true)
                      )
                    }
                    onSelect={(e) => e.preventDefault()}
                  >
                    {opt.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {activeCommandValues.map((value) => (
          <FilterChip
            key={`command-${value}`}
            label={`Command: ${COMMAND_LABELS.get(value) ?? value}`}
            onRemove={() =>
              setSelectedCommands((prev) => toggleSetValue(prev, value, false))
            }
          />
        ))}
        {activeStatusValues.map((value) => (
          <FilterChip
            key={`status-${value}`}
            label={`Status: ${STATUS_LABELS.get(value) ?? value}`}
            onRemove={() =>
              setSelectedStatuses((prev) => toggleSetValue(prev, value, false))
            }
          />
        ))}
        {activeFilterCount > 0 && (
          <Button
            onClick={() => {
              setSelectedCommands(new Set());
              setSelectedStatuses(new Set());
            }}
            size="sm"
            variant="ghost"
          >
            <XIcon className="h-3.5 w-3.5" />
            Clear filters
          </Button>
        )}
      </div>
      <DataTable
        columns={filteredColumns}
        data={filteredLoops}
        emptyMessage="No loops found. Loops are created when AI agents execute tasks."
        onPageSizeChange={setPageSize}
        onRowClick={handleRowClick}
        pageSize={pageSize}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        renderRowActions={(loop) => {
          const canCancel = CANCELLABLE_LOOP_STATUSES.has(loop.status);
          const canRestart = RESTARTABLE_LOOP_STATUSES.has(loop.status);
          if (!(canCancel || canRestart)) {
            return null;
          }
          return (
            <div className="flex items-center gap-1">
              {canCancel && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Stop loop"
                      disabled={cancellingLoopId === loop.id}
                      onClick={() => setConfirmCancelLoop(loop)}
                      size="sm"
                      variant="ghost"
                    >
                      {cancellingLoopId === loop.id ? (
                        <Loader2Icon className="h-4 w-4 animate-spin" />
                      ) : (
                        <SquareIcon className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Stop loop</TooltipContent>
                </Tooltip>
              )}
              {canRestart && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      aria-label="Restart loop"
                      disabled={
                        pendingLoopId === loop.id || resumeLoop.isPending
                      }
                      onClick={async () => {
                        await handleRestart(loop);
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      {pendingLoopId === loop.id ? (
                        <Loader2Icon className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcwIcon className="h-4 w-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Restart loop</TooltipContent>
                </Tooltip>
              )}
            </div>
          );
        }}
        rowHref={(loop) => `/${orgSlug}/loops/${loop.id}`}
      />
      <ConfirmStopLoopDialog
        onConfirm={() => {
          if (confirmCancelLoop) {
            handleCancel(confirmCancelLoop);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmCancelLoop(null);
          }
        }}
        open={confirmCancelLoop !== null}
      />
    </div>
  );
}
