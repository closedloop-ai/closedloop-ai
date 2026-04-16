"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type {
  AdditionalRepoRef,
  LoopErrorCode,
  LoopEventError,
  TokensByModel,
} from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
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
  CloudIcon,
  CoinsIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Loader2Icon,
  MonitorIcon,
  RotateCcwIcon,
  SquareIcon,
  TerminalIcon,
  UserIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmStopLoopDialog } from "@/components/loops/confirm-stop-loop-dialog";
import { LoopAuditLog } from "@/components/loops/loop-audit-log";
import { LoopProgressPanel } from "@/components/loops/loop-progress-panel";
import {
  LoopCommandBadge,
  LoopStatusBadge,
  loopErrorCodeLabels,
} from "@/components/status-badge";
import { UserLink } from "@/components/user-link";
import { useArtifact } from "@/hooks/queries/use-artifacts";
import {
  useCancelLoop,
  useLoop,
  useLoopEventsPaginated,
  useResumeLoop,
} from "@/hooks/queries/use-loops";
import { getArtifactRoute } from "@/lib/artifact-navigation";
import { formatDateTime } from "@/lib/date-utils";
import { formatDuration, formatTokenCount } from "@/lib/format-utils";
import {
  CANCELLABLE_LOOP_STATUSES,
  RESTARTABLE_LOOP_STATUSES,
} from "@/lib/loop-constants";
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
  const models = Object.entries(tokensByModel).filter(
    ([key]) => key !== "default"
  );
  if (models.length === 0) {
    return null;
  }

  const hasCacheColumns = models.some(
    ([, usage]) => (usage.cacheCreation ?? 0) > 0 || (usage.cacheRead ?? 0) > 0
  );

  return (
    <div className="mt-2 space-y-1 border-muted border-t pt-2">
      {models.map(([model, usage]) => (
        <div className="flex items-center justify-between text-xs" key={model}>
          <span className="text-muted-foreground">
            {formatModelName(model)}
          </span>
          {hasCacheColumns ? (
            <span className="tabular-nums">
              {formatTokenCount(usage.input)} in /{" "}
              {formatTokenCount(usage.output)} out /{" "}
              {formatTokenCount(usage.cacheCreation ?? 0)} cc /{" "}
              {formatTokenCount(usage.cacheRead ?? 0)} cr
            </span>
          ) : (
            <span className="tabular-nums">
              {formatTokenCount(usage.input)} / {formatTokenCount(usage.output)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

type MetadataCardsProps = {
  loop: Awaited<ReturnType<typeof useLoop>["data"]>;
};

function MetadataCards({ loop }: MetadataCardsProps) {
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
          {(() => {
            const input = loop.tokensInput;
            const output = loop.tokensOutput;
            const cacheWrite = loop.tokensByModel
              ? Object.values(loop.tokensByModel).reduce(
                  (sum, u) => sum + (u.cacheCreation ?? 0),
                  0
                )
              : 0;
            const cacheRead = loop.tokensByModel
              ? Object.values(loop.tokensByModel).reduce(
                  (sum, u) => sum + (u.cacheRead ?? 0),
                  0
                )
              : 0;
            const cost = loop.estimatedCost ?? 0;
            const isSubscription =
              (loop.metadata as Record<string, unknown>)?.apiKeySource ===
              "none";
            const hasTokens = input > 0 || output > 0;
            const hasCache = cacheWrite > 0 || cacheRead > 0;

            if (!(hasTokens || hasCache)) {
              return <div className="font-bold text-2xl">-</div>;
            }

            return (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-4">
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Input
                    </p>
                    <p className="font-semibold text-lg tabular-nums">
                      {formatTokenCount(input)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                      Output
                    </p>
                    <p className="font-semibold text-lg tabular-nums">
                      {formatTokenCount(output)}
                    </p>
                  </div>
                </div>
                {hasCache && (
                  <div className="grid grid-cols-2 gap-x-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        Cache Write
                      </p>
                      <p className="text-muted-foreground text-sm tabular-nums">
                        {formatTokenCount(cacheWrite)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        Cache Read
                      </p>
                      <p className="text-muted-foreground text-sm tabular-nums">
                        {formatTokenCount(cacheRead)}
                      </p>
                    </div>
                  </div>
                )}
                {isSubscription ? (
                  <p className="text-muted-foreground text-xs">
                    $0.00 (subscription)
                  </p>
                ) : (
                  cost > 0 && (
                    <p className="text-muted-foreground text-xs">
                      ~${cost.toFixed(2)}
                    </p>
                  )
                )}
              </div>
            );
          })()}
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

      {/* Additional Repositories Card */}
      {loop.additionalRepos && loop.additionalRepos.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">
              Additional Repositories
            </CardTitle>
            <GitBranchIcon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {loop.additionalRepos.map((repo: AdditionalRepoRef) => (
                <div key={`${repo.fullName}:${repo.branch}`}>
                  <p className="font-medium text-sm">{repo.fullName}</p>
                  <p className="text-muted-foreground text-xs">{repo.branch}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

type LoopDetailContainerProps = {
  id: string;
};

export function LoopDetailContainer({ id }: LoopDetailContainerProps) {
  const { data: loop, isLoading, error } = useLoop(id);
  const resumeLoop = useResumeLoop();
  const cancelLoop = useCancelLoop();
  const router = useRouter();
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const ghostLoopFlag = useFeatureFlag("ghost-loop-ux");
  const ghostLoopUx = ghostLoopFlag?.enabled;
  const { data: errorEvents } = useLoopEventsPaginated(
    id,
    { type: "error", limit: 1, sort: "desc" },
    { enabled: loop?.status === LoopStatus.Failed && !!ghostLoopUx }
  );

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

  const isActive = CANCELLABLE_LOOP_STATUSES.has(loop.status);
  const defaultTab = isActive ? "live" : "audit-log";
  const diagnosticsLogTail = ghostLoopUx
    ? (errorEvents?.data?.[0] as LoopEventError | undefined)?.logTail
    : undefined;

  const handleRestart = () => {
    resumeLoop.mutate(
      { id: loop.id },
      {
        onSuccess: (result) => {
          toast.success("Loop restarted");
          router.push(`/loops/${result.loopId}`);
        },
      }
    );
  };

  const handleCancel = () => {
    cancelLoop.mutate(loop.id, {
      onSuccess: () => toast.success("Loop cancelled"),
    });
  };

  return (
    <div className="space-y-6">
      {/* Back navigation */}
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="ghost">
          <Link href="/loops">
            <ArrowLeftIcon className="h-4 w-4" />
            Back to Loops
          </Link>
        </Button>
        {isActive && (
          <Button
            disabled={cancelLoop.isPending}
            onClick={() => setShowCancelConfirm(true)}
            size="sm"
            variant="outline"
          >
            {cancelLoop.isPending ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <SquareIcon className="h-4 w-4" />
            )}
            Cancel
          </Button>
        )}
        {RESTARTABLE_LOOP_STATUSES.has(loop.status) && (
          <Button
            disabled={resumeLoop.isPending}
            onClick={handleRestart}
            size="sm"
            variant="outline"
          >
            {resumeLoop.isPending ? (
              <Loader2Icon className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCcwIcon className="h-4 w-4" />
            )}
            Restart
          </Button>
        )}
      </div>

      <MetadataCards loop={loop} />

      {/* Detail row */}
      <div className="flex flex-wrap items-center gap-4 text-muted-foreground text-sm">
        <div className="flex items-center gap-1.5">
          <UserIcon className="h-3.5 w-3.5" />
          <span>
            User:{" "}
            <UserLink userId={loop.user.id}>
              {getUserDisplayName(loop.user)}
            </UserLink>
          </span>
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
        <ComputeTargetDetail loop={loop} />
      </div>

      {/* Artifact link */}
      {loop.artifactId && <ArtifactLink artifactId={loop.artifactId} />}

      {/* Error display */}
      {loop.error && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4">
          <p className="font-medium text-destructive text-sm">
            Error:{" "}
            {ghostLoopUx
              ? (loopErrorCodeLabels[loop.error.code as LoopErrorCode] ??
                loop.error.code)
              : loop.error.code}
          </p>
          <p className="mt-1 text-destructive/80 text-sm">
            {loop.error.message}
          </p>
        </div>
      )}

      {/* Diagnostics */}
      {diagnosticsLogTail && (
        <details>
          <summary>Diagnostics</summary>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
            {diagnosticsLogTail}
          </pre>
        </details>
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

      <ConfirmStopLoopDialog
        onConfirm={handleCancel}
        onOpenChange={setShowCancelConfirm}
        open={showCancelConfirm}
      />
    </div>
  );
}

function ComputeTargetDetail({
  loop,
}: {
  loop: NonNullable<Awaited<ReturnType<typeof useLoop>["data"]>>;
}) {
  if (loop.computeTarget) {
    return (
      <div className="flex items-center gap-1.5">
        <MonitorIcon className="h-3.5 w-3.5" />
        <span>
          Target: {loop.computeTarget.machineName}
          {loop.computeTarget.isOnline ? " (online)" : " (offline)"}
        </span>
      </div>
    );
  }
  if (loop.containerId) {
    return (
      <div className="flex items-center gap-1.5">
        <CloudIcon className="h-3.5 w-3.5" />
        <span>Target: Cloud</span>
      </div>
    );
  }
  return null;
}

function ArtifactLink({ artifactId }: { artifactId: string }) {
  const { data: artifact } = useArtifact(artifactId);
  const route = artifact ? getArtifactRoute(artifact) : null;

  const renderLabel = () => {
    if (!artifact) {
      return (
        <span className="text-muted-foreground text-sm">{artifactId}</span>
      );
    }
    if (route) {
      return (
        <Link className="text-sm hover:underline" href={route}>
          {artifact.title}
        </Link>
      );
    }
    return (
      <span className="text-muted-foreground text-sm">{artifact.title}</span>
    );
  };

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline">Artifact</Badge>
      {renderLabel()}
    </div>
  );
}
