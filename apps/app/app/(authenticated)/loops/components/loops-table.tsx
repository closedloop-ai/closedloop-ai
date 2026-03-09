"use client";

import type { LoopWithUser } from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { Button } from "@repo/design-system/components/ui/button";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Loader2Icon, RotateCcwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoopCommandBadge, LoopStatusBadge } from "@/components/status-badge";
import { useLoops, useResumeLoop } from "@/hooks/queries/use-loops";
import { formatRelativeTime } from "@/lib/date-utils";
import { formatDuration, formatTokenCount } from "@/lib/format-utils";
import { RESTARTABLE_LOOP_STATUSES } from "@/lib/loop-constants";
import { getUserDisplayName } from "@/lib/user-utils";

function formatTokens(input: number, output: number): string {
  const total = input + output;
  if (total === 0) {
    return "-";
  }
  return formatTokenCount(total);
}

const columns: Column<LoopWithUser>[] = [
  {
    key: "status",
    header: "Status",
    render: (loop) => <LoopStatusBadge status={loop.status} />,
  },
  {
    key: "command",
    header: "Command",
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
      <span className="text-muted-foreground text-sm">
        {getUserDisplayName(loop.user)}
      </span>
    ),
  },
  {
    key: "createdAt",
    header: "Created",
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

const sortOptions: SortOption[] = [
  { label: "Newest First", value: "createdAt:desc" },
  { label: "Oldest First", value: "createdAt:asc" },
];

export function LoopsTable() {
  const router = useRouter();
  const [commandFilter, setCommandFilter] = useState<string>("all");
  const resumeLoop = useResumeLoop();
  const [pendingLoopId, setPendingLoopId] = useState<string | null>(null);

  const filters: Record<string, string | undefined> = {};
  if (commandFilter !== "all") {
    filters.command = commandFilter;
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
        columns={columns}
        data={loops}
        emptyMessage="No loops found. Loops are created when AI agents execute tasks."
        filterKey="status"
        filterOptions={statusFilterOptions}
        onRowClick={handleRowClick}
        renderRowActions={(loop) => {
          if (!RESTARTABLE_LOOP_STATUSES.has(loop.status)) {
            return null;
          }
          return (
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
          );
        }}
        sortOptions={sortOptions}
      />
    </div>
  );
}
