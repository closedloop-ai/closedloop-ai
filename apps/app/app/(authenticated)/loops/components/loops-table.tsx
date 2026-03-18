"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type { LoopListFilters, LoopWithUser } from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type Column,
  DataTable,
  type FilterOption,
} from "@repo/design-system/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  CloudIcon,
  Loader2Icon,
  MonitorIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoopCommandBadge, LoopStatusBadge } from "@/components/status-badge";
import { UserLink } from "@/components/user-link";
import {
  useCancelLoop,
  useLoops,
  useResumeLoop,
} from "@/hooks/queries/use-loops";
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

const statusFilterOptions: FilterOption[] = [
  { label: "Pending", value: LoopStatus.Pending },
  { label: "Claimed", value: LoopStatus.Claimed },
  { label: "Running", value: LoopStatus.Running },
  { label: "Completed", value: LoopStatus.Completed },
  { label: "Failed", value: LoopStatus.Failed },
  { label: "Cancelled", value: LoopStatus.Cancelled },
  { label: "Timed Out", value: LoopStatus.TimedOut },
];

export function LoopsTable() {
  const router = useRouter();
  const tokensFlag = useFeatureFlag("the-one-flag");
  const [commandFilter, setCommandFilter] = useState<string>("all");
  const resumeLoop = useResumeLoop();
  const cancelLoop = useCancelLoop();
  const [pendingLoopId, setPendingLoopId] = useState<string | null>(null);
  const [cancellingLoopId, setCancellingLoopId] = useState<string | null>(null);

  const filters: LoopListFilters = { limit: 200 };
  if (commandFilter !== "all") {
    filters.command = commandFilter as LoopListFilters["command"];
  }

  const { data: loops = [], isLoading, error } = useLoops(filters);

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

  const handleCancel = async (loopId: string) => {
    setCancellingLoopId(loopId);
    try {
      await cancelLoop.mutateAsync(loopId);
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
        <span className="text-muted-foreground text-sm">Command:</span>
        <Select onValueChange={setCommandFilter} value={commandFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value={LoopCommand.Plan}>Plan</SelectItem>
            <SelectItem value={LoopCommand.Execute}>Execute</SelectItem>
            <SelectItem value={LoopCommand.Chat}>Chat</SelectItem>
            <SelectItem value={LoopCommand.Explore}>Explore</SelectItem>
            <SelectItem value={LoopCommand.RequestChanges}>
              Request Changes
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <DataTable
        columns={filteredColumns}
        data={loops}
        emptyMessage="No loops found. Loops are created when AI agents execute tasks."
        filterKey="status"
        filterOptions={statusFilterOptions}
        onRowClick={handleRowClick}
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
                <Button
                  aria-label="Cancel loop"
                  disabled={cancellingLoopId === loop.id}
                  onClick={async () => {
                    await handleCancel(loop.id);
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {cancellingLoopId === loop.id ? (
                    <Loader2Icon className="h-4 w-4 animate-spin" />
                  ) : (
                    <SquareIcon className="h-4 w-4" />
                  )}
                </Button>
              )}
              {canRestart && (
                <Button
                  aria-label="Restart loop"
                  disabled={pendingLoopId === loop.id}
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
              )}
            </div>
          );
        }}
      />
    </div>
  );
}
