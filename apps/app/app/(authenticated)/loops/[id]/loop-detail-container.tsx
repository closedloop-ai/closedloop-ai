"use client";

import { LoopStatus, type TokensByModel } from "@repo/api/src/types/loop";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  ClockIcon,
  CoinsIcon,
  GitBranchIcon,
  Loader2Icon,
  TerminalIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { LoopAuditLog } from "@/components/loops/loop-audit-log";
import { LoopProgressPanel } from "@/components/loops/loop-progress-panel";
import { LoopCommandBadge, LoopStatusBadge } from "@/components/status-badge";
import { useLoop } from "@/hooks/queries/use-loops";
import { formatDateTime } from "@/lib/date-utils";

function formatDuration(
  startedAt: Date | null,
  completedAt: Date | null
): string {
  if (!startedAt) {
    return "-";
  }
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

function formatModelName(model: string): string {
  return model
    .replace("claude-", "")
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function ModelTokenBreakdown({
  tokensByModel,
}: {
  tokensByModel: TokensByModel;
}) {
  const models = Object.entries(tokensByModel);
  if (models.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1 border-muted border-t pt-2">
      {models.map(([model, usage]) => (
        <div className="flex items-center justify-between text-xs" key={model}>
          <span className="text-muted-foreground">
            {formatModelName(model)}
          </span>
          <span className="tabular-nums">
            {formatTokenCount(usage.input)} / {formatTokenCount(usage.output)}
          </span>
        </div>
      ))}
    </div>
  );
}

const ACTIVE_STATUSES: Set<string> = new Set([
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
]);

type LoopDetailContainerProps = {
  id: string;
};

export function LoopDetailContainer({ id }: LoopDetailContainerProps) {
  const { data: loop, isLoading, error } = useLoop(id);

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
        {error.message ?? "Failed to load loop"}
      </div>
    );
  }

  if (!loop) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircleIcon className="mb-2 h-8 w-8 text-muted-foreground/50" />
        <p className="text-muted-foreground">Loop not found</p>
      </div>
    );
  }

  const isActive = ACTIVE_STATUSES.has(loop.status);
  const totalTokens = loop.tokensInput + loop.tokensOutput;
  const defaultTab = isActive ? "live" : "audit-log";

  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/loops">
            <ArrowLeftIcon className="mr-1 h-4 w-4" />
            Back to Loops
          </Link>
        </Button>
      </div>

      {/* Metadata cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Status</CardTitle>
            <ClockIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <LoopStatusBadge status={loop.status} />
            {loop.startedAt && (
              <p className="mt-2 text-muted-foreground text-xs">
                Duration: {formatDuration(loop.startedAt, loop.completedAt)}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Command</CardTitle>
            <TerminalIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <LoopCommandBadge command={loop.command} />
            {loop.prompt && (
              <p className="mt-2 line-clamp-2 text-muted-foreground text-xs">
                {loop.prompt}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Tokens</CardTitle>
            <CoinsIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {totalTokens > 0 ? formatTokenCount(totalTokens) : "-"}
            </div>
            {totalTokens > 0 && (
              <p className="text-muted-foreground text-xs">
                {formatTokenCount(loop.tokensInput)} in /{" "}
                {formatTokenCount(loop.tokensOutput)} out
              </p>
            )}
            {loop.estimatedCost != null && loop.estimatedCost > 0 && (
              <p className="mt-1 text-muted-foreground text-xs">
                ~${loop.estimatedCost.toFixed(4)}
              </p>
            )}
            {loop.tokensByModel && (
              <ModelTokenBreakdown tokensByModel={loop.tokensByModel} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Repository</CardTitle>
            <GitBranchIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loop.repo ? (
              <>
                <p className="font-medium text-sm">{loop.repo.fullName}</p>
                <p className="text-muted-foreground text-xs">
                  {loop.repo.branch}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">-</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Detail row */}
      <div className="flex flex-wrap items-center gap-4 text-muted-foreground text-sm">
        <div className="flex items-center gap-1.5">
          <UserIcon className="h-3.5 w-3.5" />
          <span>User: {loop.userId}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ClockIcon className="h-3.5 w-3.5" />
          <span>Created: {formatDateTime(loop.createdAt)}</span>
        </div>
        {loop.startedAt && (
          <div className="flex items-center gap-1.5">
            <ClockIcon className="h-3.5 w-3.5" />
            <span>Started: {formatDateTime(loop.startedAt)}</span>
          </div>
        )}
        {loop.completedAt && (
          <div className="flex items-center gap-1.5">
            <ClockIcon className="h-3.5 w-3.5" />
            <span>Completed: {formatDateTime(loop.completedAt)}</span>
          </div>
        )}
      </div>

      {/* Artifact link */}
      {loop.artifactId && (
        <div className="flex items-center gap-2">
          <Badge variant="outline">Artifact</Badge>
          <span className="text-muted-foreground text-sm">
            {loop.artifactId}
          </span>
        </div>
      )}

      {/* Error display */}
      {loop.error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4">
          <p className="font-medium text-destructive text-sm">
            Error: {loop.error.code}
          </p>
          <p className="mt-1 text-destructive/80 text-sm">
            {loop.error.message}
          </p>
        </div>
      )}

      {/* Tabs: Live / Audit Log */}
      <Tabs defaultValue={defaultTab}>
        <TabsList className="h-auto rounded-none border-border border-b bg-transparent p-0">
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="live"
          >
            Live
            {isActive && (
              <span className="ml-2 inline-block size-2 animate-pulse rounded-full bg-blue-500" />
            )}
          </TabsTrigger>
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="audit-log"
          >
            Audit Log
          </TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4" value="live">
          <div className="h-[500px]">
            <LoopProgressPanel loopId={id} />
          </div>
        </TabsContent>

        <TabsContent className="mt-4" value="audit-log">
          <LoopAuditLog loopId={id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
