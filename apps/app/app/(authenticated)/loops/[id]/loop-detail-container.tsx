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
import { toast } from "@repo/design-system/components/ui/sonner";
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
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Loader2Icon,
  RotateCcwIcon,
  TerminalIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LoopAuditLog } from "@/components/loops/loop-audit-log";
import { LoopProgressPanel } from "@/components/loops/loop-progress-panel";
import { LoopCommandBadge, LoopStatusBadge } from "@/components/status-badge";
import { useLoop, useResumeLoop } from "@/hooks/queries/use-loops";
import { formatDateTime } from "@/lib/date-utils";
import { formatDuration, formatTokenCount } from "@/lib/format-utils";
import { RESTARTABLE_LOOP_STATUSES } from "@/lib/loop-constants";
import { getUserDisplayName } from "@/lib/user-utils";

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

type MetadataCardsProps = {
  loop: Awaited<ReturnType<typeof useLoop>["data"]>;
  totalTokens: number;
};

function MetadataCards({ loop, totalTokens }: MetadataCardsProps) {
  if (!loop) {
    return null;
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {/* Status Card */}
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

      {/* Command Card */}
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

      {/* Tokens Card */}
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

      {/* Repository Card */}
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
                {loop.branchName || loop.repo.branch}
              </p>
              {loop.prUrl && (
                <a
                  className="mt-2 inline-flex items-center gap-1.5 text-blue-600 text-xs hover:underline dark:text-blue-400"
                  href={loop.prUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <GitPullRequestIcon className="h-3.5 w-3.5" />
                  PR #{loop.prNumber}
                  <ExternalLinkIcon className="h-3 w-3" />
                </a>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">-</p>
          )}
        </CardContent>
      </Card>
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
  const resumeLoop = useResumeLoop();
  const router = useRouter();

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

  const handleRestart = async () => {
    try {
      const result = await resumeLoop.mutateAsync({ id: loop.id });
      toast.success("Loop restarted");
      router.push(`/loops/${result.loopId}`);
    } catch {
      // Global QueryClient onError handler toasts the error
    }
  };

  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link href="/loops">
            <ArrowLeftIcon className="mr-1 h-4 w-4" />
            Back to Loops
          </Link>
        </Button>
        {RESTARTABLE_LOOP_STATUSES.has(loop.status) && (
          <Button
            disabled={resumeLoop.isPending}
            onClick={async () => {
              await handleRestart();
            }}
            size="sm"
            variant="outline"
          >
            {resumeLoop.isPending ? (
              <Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RotateCcwIcon className="mr-2 h-4 w-4" />
            )}
            Restart
          </Button>
        )}
      </div>

      <MetadataCards loop={loop} totalTokens={totalTokens} />

      {/* Detail row */}
      <div className="flex flex-wrap items-center gap-4 text-muted-foreground text-sm">
        <div className="flex items-center gap-1.5">
          <UserIcon className="h-3.5 w-3.5" />
          <span>User: {getUserDisplayName(loop.user)}</span>
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
        {loop.sessionId && (
          <div className="flex items-center gap-1.5">
            <TerminalIcon className="h-3.5 w-3.5" />
            <span title={loop.sessionId}>
              Session: {loop.sessionId.slice(0, 8)}...
            </span>
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
