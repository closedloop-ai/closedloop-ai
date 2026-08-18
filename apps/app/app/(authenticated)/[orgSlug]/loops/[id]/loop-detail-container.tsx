"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY } from "@repo/api/src/types/compute-target";
import type { FriendlyErrorInput } from "@repo/api/src/types/friendly-error";
import type {
  AdditionalRepoRefWithPr,
  LoopDetail,
  LoopError,
  LoopEventError,
  LoopSupportArtifact,
  TokensByModel,
} from "@repo/api/src/types/loop";
import { LoopStatus } from "@repo/api/src/types/loop";
import { useDocument } from "@repo/app/documents/hooks/use-documents";
import {
  getDocumentRoute,
  withOrgSlug,
} from "@repo/app/documents/lib/document-navigation";
import { ConfirmStopLoopDialog } from "@repo/app/loops/components/confirm-stop-loop-dialog";
import { LoopAuditLog } from "@repo/app/loops/components/loop-audit-log";
import { LoopProgressPanel } from "@repo/app/loops/components/loop-progress-panel";
import { LoopStatusBadge } from "@repo/app/loops/components/loop-status-badge";
import {
  useLoop,
  useLoopEventsPaginated,
  useResumeLoop,
} from "@repo/app/loops/hooks/use-loops";
import {
  CANCELLABLE_LOOP_STATUSES,
  RESTARTABLE_LOOP_STATUSES,
} from "@repo/app/loops/lib/loop-constants";
import {
  getLoopBreadcrumbLabel,
  shortLoopId,
} from "@repo/app/loops/lib/loop-display";
import { loopLinkClassName } from "@repo/app/loops/lib/loop-link";
import { ApiError, getErrorMessage } from "@repo/app/shared/api/api-error";
import { FriendlyErrorAlert } from "@repo/app/shared/components/friendly-error-alert";
import { LoopCommandBadge } from "@repo/app/shared/components/status-badge";
import { UserLink } from "@repo/app/shared/components/user-link";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useDocumentTitle } from "@repo/app/shared/hooks/use-document-title";
import { formatDateTime } from "@repo/app/shared/lib/date-utils";
import {
  formatDuration,
  formatTokenCount,
} from "@repo/app/shared/lib/format-utils";
import { getUserDisplayName } from "@repo/app/shared/lib/user-utils";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import {
  AlertCircleIcon,
  ClockIcon,
  CloudIcon,
  CoinsIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Loader2Icon,
  MonitorIcon,
  RotateCcwIcon,
  SquareIcon,
  TerminalIcon,
  UserIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { useCancelLoop } from "@/hooks/queries/use-loops";
import { useOrgSlug } from "@/hooks/use-org-slug";
import { buildLoopBreadcrumbs } from "./loop-breadcrumbs";

function toFriendlyErrorInput(error: unknown): FriendlyErrorInput {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      details: error.details,
      message: error.message,
      timestamp: error.timestamp,
    };
  }
  return {
    message:
      error instanceof Error ? error.message : "Loop restart failed to start.",
  };
}

function getRestartRequest(
  loop: {
    id: string;
    computeTarget?: { id: string } | null;
  },
  preserveComputeTarget: boolean
) {
  const computeTargetId = loop.computeTarget?.id;
  return preserveComputeTarget && computeTargetId
    ? { id: loop.id, computeTargetId }
    : { id: loop.id };
}

function LoopErrorAlerts({
  loopError,
  restartError,
}: {
  loopError: LoopError | null;
  restartError: FriendlyErrorInput | null;
}) {
  return (
    <>
      {restartError && <FriendlyErrorAlert error={restartError} />}
      {loopError && (
        <FriendlyErrorAlert
          error={{
            code: loopError.code,
            message: loopError.message,
            result: loopError.result ?? undefined,
          }}
        />
      )}
    </>
  );
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

function renderPrLink(
  pr: NonNullable<AdditionalRepoRefWithPr["pullRequest"]>,
  branchPrEnabled: boolean,
  orgSlug: string
) {
  if (branchPrEnabled && pr.externalLinkId) {
    return (
      <Link
        className={loopLinkClassName("mt-1")}
        href={`/${orgSlug}/build/${pr.externalLinkId}`}
      >
        <GitPullRequestIcon className="h-3.5 w-3.5" />
        PR #{pr.number}
      </Link>
    );
  }
  return (
    <a
      className={loopLinkClassName("mt-1")}
      href={pr.htmlUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <GitPullRequestIcon className="h-3.5 w-3.5" />
      PR #{pr.number}
      <ExternalLinkIcon className="h-3 w-3" />
    </a>
  );
}

function renderBranchLink(
  branch: NonNullable<LoopDetail["primaryBranch"]>,
  orgSlug: string
) {
  const content = (
    <>
      <GitBranchIcon className="h-3.5 w-3.5" />
      {branch.branchName}
    </>
  );
  if (branch.externalLinkId) {
    return (
      <Link
        className={loopLinkClassName("mt-1")}
        href={`/${orgSlug}/build/${branch.externalLinkId}`}
      >
        {content}
      </Link>
    );
  }
  if (branch.htmlUrl) {
    return (
      <a
        className={loopLinkClassName("mt-1")}
        href={branch.htmlUrl}
        rel="noopener noreferrer"
        target="_blank"
      >
        {content}
        <ExternalLinkIcon className="h-3 w-3" />
      </a>
    );
  }
  return (
    <span className="mt-1 inline-flex items-center gap-1.5 text-muted-foreground text-xs">
      {content}
    </span>
  );
}

function renderLegacyLoopPrLink(loop: NonNullable<MetadataCardsProps["loop"]>) {
  if (!loop.prUrl) {
    return null;
  }
  return (
    <a
      className={loopLinkClassName("mt-2")}
      href={loop.prUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      <GitPullRequestIcon className="h-3.5 w-3.5" />
      PR #{loop.prNumber}
      <ExternalLinkIcon className="h-3 w-3" />
    </a>
  );
}

function renderPrimaryRepoArtifact(
  loop: NonNullable<MetadataCardsProps["loop"]>,
  branchPrEnabled: boolean,
  orgSlug: string
) {
  if (branchPrEnabled && loop.primaryBranch) {
    return renderBranchLink(loop.primaryBranch, orgSlug);
  }
  if (loop.primaryPullRequest) {
    return renderPrLink(loop.primaryPullRequest, branchPrEnabled, orgSlug);
  }
  return renderLegacyLoopPrLink(loop);
}

function renderAdditionalRepoArtifact(
  repo: AdditionalRepoRefWithPr,
  branchPrEnabled: boolean,
  orgSlug: string
) {
  if (branchPrEnabled && repo.branchArtifact) {
    return renderBranchLink(repo.branchArtifact, orgSlug);
  }
  if (repo.pullRequest) {
    return renderPrLink(repo.pullRequest, branchPrEnabled, orgSlug);
  }
  return null;
}

type MetadataCardsProps = {
  loop: Awaited<ReturnType<typeof useLoop>["data"]>;
};

function MetadataCards({ loop }: MetadataCardsProps) {
  const branchPrFlag = useFeatureFlag("branch-pr");
  const branchPrEnabled = branchPrFlag?.enabled === true;
  const orgSlug = useOrgSlug();

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
          {/*
            Pass the persisted error code, not just the status: for a launch
            failure (ISS-5711) this badge is the first place a user learns the
            run never started, and status alone renders a generic "Failed".
          */}
          <LoopStatusBadge errorCode={loop.error?.code} status={loop.status} />
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
              {renderPrimaryRepoArtifact(loop, branchPrEnabled, orgSlug)}
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
              {loop.additionalRepos.map((repo: AdditionalRepoRefWithPr) => (
                <div key={`${repo.fullName}:${repo.branch}`}>
                  <p className="font-medium text-sm">{repo.fullName}</p>
                  <p className="text-muted-foreground text-xs">{repo.branch}</p>
                  {renderAdditionalRepoArtifact(repo, branchPrEnabled, orgSlug)}
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
  const orgSlug = useOrgSlug();
  const { data: loop, isLoading, error } = useLoop(id);
  const resumeLoop = useResumeLoop();
  const cancelLoop = useCancelLoop();
  const navigation = useNavigation();
  // Resolve the loop's artifact title for the breadcrumb. React Query dedupes
  // this against the same `useDocument` call inside `ArtifactLink` below (same
  // query key), so lifting it here does not add a request. Gated on
  // `loop?.documentId` — document-less loops fall back to the command noun.
  const { data: breadcrumbArtifact, isFetched: breadcrumbArtifactFetched } =
    useDocument(loop?.documentId ?? null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [restartError, setRestartError] = useState<FriendlyErrorInput | null>(
    null
  );
  const explicitComputeSelectionEnabled = useFeatureFlagEnabled(
    EXPLICIT_COMPUTE_SELECTION_FEATURE_FLAG_KEY
  );
  const ghostLoopFlag = useFeatureFlag("ghost-loop-ux");
  const ghostLoopUx = ghostLoopFlag?.enabled;
  const { data: errorEvents } = useLoopEventsPaginated(
    id,
    { type: "error", limit: 1, sort: "desc" },
    { enabled: loop?.status === LoopStatus.Failed && !!ghostLoopUx }
  );

  // Celebrate the moment a running loop ships. The status refreshes via the
  // mounted LoopProgressPanel's useLoopPolling (useLoop itself does not poll),
  // so we watch the RUNNING -> COMPLETED edge here and toast once.
  const shipCelebrationFlag = useFeatureFlag("loop-ship-celebration");
  const shipCelebrationEnabled = shipCelebrationFlag?.enabled === true;
  const prevStatusRef = useRef<LoopStatus | undefined>(undefined);
  useEffect(() => {
    const status = loop?.status;
    const previousStatus = prevStatusRef.current;
    prevStatusRef.current = status;
    if (
      !(
        shipCelebrationEnabled &&
        previousStatus === LoopStatus.Running &&
        status === LoopStatus.Completed
      )
    ) {
      return;
    }
    // Enrich the celebration with the already-loaded loop context: the shipped
    // PR as a deep link and a one-line duration summary. LOC/$ is not part of the
    // loaded LoopDetail, so we only surface data we actually have.
    //
    // Prefer the document-projected `primaryPullRequest`, but fall back to the
    // legacy per-loop PR fields (`loop.prNumber`/`loop.prUrl`) when it is
    // absent — document-less/legacy loops only carry PR data on the loop row
    // (the API only builds `primaryPullRequest` from document PR projections),
    // so without this fallback the toast would drop both the PR number and the
    // "View PR" action even though the data is loaded. Mirrors
    // renderLegacyLoopPrLink above.
    const shippedPr = loop?.primaryPullRequest;
    const shippedPrNumber = shippedPr?.number ?? loop?.prNumber ?? null;
    const shippedPrUrl = shippedPr?.htmlUrl ?? loop?.prUrl ?? undefined;
    // Require BOTH endpoints: formatDuration treats a null completedAt as
    // "still running" and measures start→now, which would show a running-clock
    // value for an already-completed loop if completedAt lags the status flip at
    // this RUNNING→COMPLETED edge. Drop the segment until the merge instant is
    // known rather than surfacing an ever-growing duration.
    const duration =
      loop?.startedAt && loop?.completedAt
        ? formatDuration(loop.startedAt, loop.completedAt)
        : null;
    const summaryParts: string[] = [];
    if (shippedPrNumber !== null) {
      summaryParts.push(`PR #${shippedPrNumber}`);
    }
    if (duration && duration !== "-") {
      summaryParts.push(`shipped in ${duration}`);
    }
    toast.success("Shipped! 🎉", {
      description:
        summaryParts.length > 0 ? summaryParts.join(" · ") : undefined,
      action: shippedPrUrl
        ? {
            label: "View PR",
            onClick: () =>
              window.open(shippedPrUrl, "_blank", "noopener,noreferrer"),
          }
        : undefined,
    });
  }, [
    loop?.status,
    loop?.startedAt,
    loop?.completedAt,
    loop?.primaryPullRequest,
    loop?.prNumber,
    loop?.prUrl,
    shipCelebrationEnabled,
  ]);

  // Breadcrumb/tab identity for the loop (see `resolveLoopBreadcrumbLabel`).
  const breadcrumbLabel = resolveLoopBreadcrumbLabel({
    loop,
    artifactTitle: breadcrumbArtifact?.title,
    artifactFetched: breadcrumbArtifactFetched,
    routeId: id,
  });

  // ISS-4477: with the Loops list retired, the loop's producing document/plan is
  // the only real parent — and how the user actually reached this run. Crumb it
  // as the parent (the Header treats the second-to-last crumb as the back path)
  // and keep the loop label as the leaf. Falls back to a single leaf crumb for
  // document-less/legacy loops, which have no parent to point at.
  const breadcrumbs = buildLoopBreadcrumbs({
    orgSlug,
    breadcrumbArtifact,
    breadcrumbLabel,
  });

  // Name the browser tab the same as the crumb so several open loop tabs are
  // distinguishable — the static route `metadata` only carries a generic title.
  // It degrades to the route placeholder while the loop/artifact load.
  //
  // ISS-5574 (review on #4661): through the shared hook, not a bare effect with
  // its own `"Closedloop.ai"` literal. Two copies of the product name is how a
  // rename splits, and more than that: this was the one writer in the repo that
  // never restored, so a soft navigation off a loop left "<loop> | Closedloop.ai"
  // to be captured and later handed back by any page that DOES restore. The
  // hook's unmount cleanup closes that.
  useDocumentTitle(breadcrumbLabel);

  const renderShell = (children: ReactNode, headerActions?: ReactNode) => (
    <LoopDetailShell breadcrumbs={breadcrumbs} headerActions={headerActions}>
      {children}
    </LoopDetailShell>
  );

  if (isLoading) {
    return renderShell(
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return renderShell(
      <Alert variant="error">
        <AlertDescription>
          {error.message ?? "Failed to load loop"}
        </AlertDescription>
      </Alert>
    );
  }

  if (!loop) {
    return renderShell(
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircleIcon className="mb-2 h-8 w-8 text-muted-foreground/50" />
        <p className="text-muted-foreground">Loop not found</p>
      </div>
    );
  }

  const isActive = CANCELLABLE_LOOP_STATUSES.has(loop.status);
  const defaultTab = isActive ? "live" : "audit-log";
  const supportArtifacts = loop.supportArtifacts ?? [];
  const diagnosticsLogTail = ghostLoopUx
    ? (errorEvents?.data?.[0] as LoopEventError | undefined)?.logTail
    : undefined;
  const handleRestart = () => {
    setRestartError(null);
    resumeLoop.mutate(
      getRestartRequest(loop, explicitComputeSelectionEnabled),
      {
        onSuccess: (result) => {
          toast.success("Loop restarted");
          navigation.navigate(`/${orgSlug}/loops/${result.loopId}`);
        },
        onError: (error) => {
          setRestartError(toFriendlyErrorInput(error));
          toast.error("Loop restart failed", {
            description: getErrorMessage(error),
          });
        },
      }
    );
  };

  const handleCancel = () => {
    cancelLoop.mutate(
      { id: loop.id, computeTargetId: loop.computeTarget?.id ?? null },
      {
        onSuccess: () => toast.success("Loop cancelled"),
      }
    );
  };

  // Primary actions live in the Header's right slot (as branch detail's Refresh
  // and session detail's actions do). This detail is reached from the plan and
  // document-run flows that spawn the execution, so there is no separate
  // "Back to Loops" button.
  const headerActions = (
    <>
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
    </>
  );

  return renderShell(
    <div className="space-y-6">
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
      {loop.documentId && <ArtifactLink documentId={loop.documentId} />}

      {/* Error display */}
      <LoopErrorAlerts loopError={loop.error} restartError={restartError} />

      {/* Diagnostics */}
      {diagnosticsLogTail && (
        <details>
          <summary>Diagnostics</summary>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
            {diagnosticsLogTail}
          </pre>
        </details>
      )}

      {/* Tabs: Live / Audit Log / Artifacts */}
      <Tabs defaultValue={defaultTab}>
        <TabsList className="h-auto rounded-none border-border border-b bg-transparent p-0">
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="live"
          >
            Live
            {isActive && (
              <span className="ml-2 inline-block size-2 animate-pulse rounded-full bg-info" />
            )}
          </TabsTrigger>
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="audit-log"
          >
            Audit Log
          </TabsTrigger>
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="artifacts"
          >
            Artifacts
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

        <TabsContent className="mt-4" value="artifacts">
          <SupportArtifacts artifacts={supportArtifacts} />
        </TabsContent>
      </Tabs>

      <ConfirmStopLoopDialog
        onConfirm={handleCancel}
        onOpenChange={setShowCancelConfirm}
        open={showCancelConfirm}
      />
    </div>,
    headerActions
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

function ArtifactLink({ documentId }: { documentId: string }) {
  const { data: artifact } = useDocument(documentId);
  const orgSlug = useOrgSlug();
  const route = artifact
    ? withOrgSlug(orgSlug, getDocumentRoute(artifact))
    : null;

  const renderLabel = () => {
    if (!artifact) {
      return (
        <span className="text-muted-foreground text-sm">{documentId}</span>
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

function SupportArtifacts({ artifacts }: { artifacts: LoopSupportArtifact[] }) {
  if (artifacts.length === 0) {
    return (
      <EmptyState
        className="rounded-md border border-dashed"
        description="This loop did not produce support artifacts."
        icon={FileTextIcon}
        title="No support artifacts uploaded"
      />
    );
  }

  return (
    <section className="space-y-2">
      <h2 className="font-medium text-sm">Support Artifacts</h2>
      <div className="flex flex-wrap gap-2">
        {artifacts.map((artifact) => (
          <a
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            download={artifact.name}
            href={artifact.downloadUrl}
            key={artifact.key}
            rel="noopener noreferrer"
            target="_blank"
          >
            <FileTextIcon className="h-4 w-4 text-muted-foreground" />
            <span>{artifact.name}</span>
            <DownloadIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </a>
        ))}
      </div>
    </section>
  );
}

/**
 * Page chrome for the loop-detail route: the breadcrumb header plus the
 * scrollable main region. Owned here (not in the server `page.tsx`) so the
 * breadcrumb can name the loop from the client-loaded loop record, matching
 * how branch/artifact detail render their header inside the client component.
 */
function LoopDetailShell({
  breadcrumbs,
  headerActions,
  children,
}: {
  breadcrumbs: BreadcrumbEntry[];
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {/* ISS-4477: the "Loops" list concept is retired from nav & UI, so the
          former "Loops" list crumb (which linked to the removed landing page) is
          gone. The crumb chain is built by `buildLoopBreadcrumbs`: the loop's
          producing document/plan as the parent (the back path) when known, with
          the loop's own label as the leaf — matching how branch/artifact detail
          crumb their parent. */}
      <Header breadcrumbs={breadcrumbs}>{headerActions}</Header>
      {/* plain <div>, not <main>: the shell's SidebarInset owns the page's single main landmark (no-nested-main-landmark gate). */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
        {children}
      </div>
    </>
  );
}

/**
 * Resolves the loop's breadcrumb/tab label. `getLoopBreadcrumbLabel` names it
 * by the command noun plus the artifact it implements (FEA/PRD title), else a
 * short id — mirroring how branch/artifact detail name their record.
 *
 * The label must never flash: (1) while the loop record loads, or (2) once the
 * loop has a `documentId` but its title query has not settled — in either case
 * fall through to a short-id placeholder derived from the route id (`Loop
 * 3f2a91b4`) rather than the generic "Loop Detail" or a bare noun that would
 * immediately swap to the titled label. This same short-id placeholder also
 * names the terminal error and not-found shells, which never resolve a loop, so
 * those pages stay distinguishable instead of reading a generic "Loop" forever.
 */
function resolveLoopBreadcrumbLabel({
  loop,
  artifactTitle,
  artifactFetched,
  routeId,
}: {
  loop: LoopDetail | undefined;
  artifactTitle: string | undefined;
  artifactFetched: boolean;
  routeId: string;
}): string {
  const artifactTitleSettled = !loop?.documentId || artifactFetched;
  if (loop && artifactTitleSettled) {
    return getLoopBreadcrumbLabel(loop, artifactTitle);
  }
  return `Loop ${shortLoopId(routeId)}`;
}
