"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type { LoopWithUser } from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
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
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import {
  CloudIcon,
  FilterIcon,
  Loader2Icon,
  MonitorIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ConfirmStopLoopDialog } from "@/components/loops/confirm-stop-loop-dialog";
import { LoopCommandBadge, LoopStatusBadge } from "@/components/status-badge";
import { UserLink } from "@/components/user-link";
import {
  useCancelLoop,
  useLoops,
  useResumeLoop,
} from "@/hooks/queries/use-loops";
import { useLocalStorageState } from "@/hooks/use-local-storage-state";
import { formatRelativeTime } from "@/lib/date-utils";
import { formatDuration, formatTokenCount } from "@/lib/format-utils";
import {
  CANCELLABLE_LOOP_STATUSES,
  RESTARTABLE_LOOP_STATUSES,
} from "@/lib/loop-constants";
import { getUserDisplayName } from "@/lib/user-utils";

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

function toggleSetValue(
  set: Set<string>,
  value: string,
  add: boolean
): Set<string> {
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
  { label: "Claimed", value: LoopStatus.Claimed },
  { label: "Running", value: LoopStatus.Running },
  { label: "Completed", value: LoopStatus.Completed },
  { label: "Failed", value: LoopStatus.Failed },
  { label: "Cancelled", value: LoopStatus.Cancelled },
  { label: "Timed Out", value: LoopStatus.TimedOut },
];

const DEFAULT_PAGE_SIZE = 10;

export function LoopsTable() {
  const router = useRouter();
  const tokensFlag = useFeatureFlag("the-one-flag");
  const [pageSize, setPageSize] = useLocalStorageState(
    "loops:table:pageSize",
    DEFAULT_PAGE_SIZE
  );
  const [selectedCommands, setSelectedCommands] = useState<Set<string>>(
    new Set()
  );
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
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

  const handleRowClick = (loop: LoopWithUser) => {
    router.push(`/loops/${loop.id}`);
  };

  const handleRestart = async (loopId: string) => {
    setPendingLoopId(loopId);
    try {
      const result = await resumeLoop.mutateAsync({ id: loopId });
      toast.success("Loop restarted");
      router.push(`/loops/${result.loopId}`);
    } catch {
      // Global QueryClient onError handler toasts the error
    } finally {
      setPendingLoopId(null);
    }
  };

  const handleCancel = async (loop: LoopWithUser) => {
    setCancellingLoopId(loop.id);
    try {
      await cancelLoop.mutateAsync({
        id: loop.id,
        computeTargetId: loop.computeTarget?.id ?? null,
      });
      toast.success("Loop cancelled");
    } catch {
      // Global QueryClient onError handler toasts the error
    } finally {
      setCancellingLoopId(null);
    }
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
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error.message ?? "Failed to load loops"}
      </div>
    );
  }

  const filteredColumns = tokensFlag?.enabled
    ? columns
    : columns.filter((column) => column.key !== "tokens");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
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
                        await handleRestart(loop.id);
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
