"use client";

import {
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/artifact";
import type {
  GenerationStatus,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { OverflowMenu } from "@repo/app/documents/components/relationships/overflow-menu";
import { RunInFlightReason } from "@repo/app/documents/components/run-action-availability";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import { useDocumentPullRequest } from "@repo/app/documents/hooks/use-documents";
import { isRunInFlightForCommand } from "@repo/app/documents/lib/generation-status-utils";
import {
  getPullRequestLifecycle,
  PullRequestLifecycleLabels,
} from "@repo/app/github/lib/pull-request-lifecycle";
import {
  useFeatureFlagEnabled,
  useFeatureFlagEnabledOptional,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { GitBranchIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { SelectPullRequestDialog } from "./select-pr-dialog";

type BranchesSectionProps = {
  documentId: string;
  projectId: string;
  planId: string | null;
  onStartBuild?: () => void;
  generationStatus?: GenerationStatus;
};

export function BranchesSection({
  documentId,
  projectId,
  planId,
  onStartBuild,
  generationStatus,
}: Readonly<BranchesSectionProps>) {
  const [showSelectPr, setShowSelectPr] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const reasonId = useId();
  const branchPrEnabled = useFeatureFlagEnabled("branch-pr");
  // ISS-5508: closed by default. OFF, "Start Building" keeps the native
  // `disabled` it has always rendered and no explanation exists.
  const explainUnavailable = useFeatureFlagEnabledOptional(
    ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY
  );
  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(documentId, {
    mode: LinkQueryMode.Tree,
    direction: LinkDirection.Target,
  });
  const deleteLink = useDeleteArtifactLink();

  function handleUnlink(linkId: string) {
    deleteLink.mutate(linkId, {
      onSuccess: () => {
        toast.success("Branch unlinked");
      },
    });
  }

  // Branch artifacts are the durable build artifact. While the rollout flag is
  // off, only show branch rows that still have current PR-compatible state.
  const branchLinks = resolvedLinks.filter(
    (link) =>
      link.target.type === ArtifactType.Branch &&
      (branchPrEnabled || link.target.branch?.currentPullRequest)
  );

  const hasBranches = branchLinks.length > 0;
  const { data: pullRequests = [] } = useDocumentPullRequest(documentId, {
    enabled: isOpen && hasBranches,
  });
  const pullRequestsByBranchId = useMemo(() => {
    const byId = new Map<string, PullRequestInfo>();
    for (const pullRequest of pullRequests) {
      if (pullRequest.externalLinkId) {
        byId.set(pullRequest.externalLinkId, pullRequest);
      }
      byId.set(pullRequest.id, pullRequest);
    }
    return byId;
  }, [pullRequests]);
  // ISS-5474: `generationStatus` gates the "Start Building" action only — it
  // must not surface run state to the user. The removed indicator rendered a
  // Loop-linked "Executing plan..." line here.
  //
  // ISS-5508: it may now also say WHY the gate is closed, which is a different
  // claim — that this control is unavailable, not what the run is doing. Nothing
  // below names the run, its status, its outcome, or links to it.
  const isExecutingPlan = isRunInFlightForCommand({
    generationStatus,
    targetCommand: RunLoopCommand.Execute,
  });
  const explainStartBuilding = explainUnavailable && isExecutingPlan;

  return (
    <div className="bg-background">
      <SectionHeader
        isOpen={isOpen}
        onToggle={() => setIsOpen((prev) => !prev)}
        title="Build"
      >
        <Button
          aria-label="Add pull request"
          onClick={() => setShowSelectPr(true)}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </SectionHeader>
      {isOpen &&
        (hasBranches ? (
          <div className="flex flex-col">
            {branchLinks.map((link) => (
              <BranchRow
                key={link.id}
                link={link}
                onUnlink={handleUnlink}
                pullRequest={pullRequestsByBranchId.get(link.target.id)}
              />
            ))}
          </div>
        ) : (
          <div className="flex items-center py-3">
            <div className="flex flex-1 flex-col gap-4">
              <p className="text-base text-muted-foreground">
                No branch exists yet
              </p>
              <div className="flex gap-4">
                {planId ? (
                  <Button
                    aria-describedby={
                      explainStartBuilding ? reasonId : undefined
                    }
                    aria-disabled={explainStartBuilding || undefined}
                    className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                    disabled={isExecutingPlan && !explainStartBuilding}
                    onClick={explainStartBuilding ? undefined : onStartBuild}
                    size="sm"
                    variant="secondary"
                  >
                    Start Building
                    <PlayIcon className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button disabled size="sm" variant="secondary">
                    Need approved plan to build
                  </Button>
                )}
                <Button
                  onClick={() => setShowSelectPr(true)}
                  size="sm"
                  variant="outline"
                >
                  Select Existing PR
                </Button>
              </div>
              {/* `live`: the user pressed this button, so focus is still on it
                  when the poll flips seconds later. Adding `aria-describedby` to
                  an already-focused element is not re-announced, so this one
                  instance needs a live region. The menu note does not — a menu
                  is opened after the fact, and a live region there would fire on
                  every open. */}
              {explainStartBuilding ? (
                <RunInFlightReason id={reasonId} live />
              ) : null}
            </div>
          </div>
        ))}
      <SelectPullRequestDialog
        documentId={documentId}
        onOpenChange={setShowSelectPr}
        open={showSelectPr}
        planId={planId}
        projectId={projectId}
      />
    </div>
  );
}

type BranchRowProps = {
  link: ArtifactLinkWithEndpoints;
  onUnlink: (linkId: string) => void;
  pullRequest?: PullRequestInfo;
};

export function BranchRow({
  link,
  onUnlink,
  pullRequest,
}: Readonly<BranchRowProps>) {
  const buildOrgPath = useOrgPath();
  const branchEndpoint = link.target;
  if (branchEndpoint.type !== ArtifactType.Branch) {
    return null;
  }
  const branchName = branchEndpoint.branch?.branchName ?? branchEndpoint.name;
  const lifecycle = getPullRequestLifecycle(
    pullRequest ?? branchEndpoint.branch?.currentPullRequest ?? null,
    branchEndpoint.status
  );

  return (
    <div className="flex items-center gap-4 px-2 py-1">
      <Link
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md hover:bg-accent"
        href={buildOrgPath(`/build/${branchEndpoint.id}`)}
      >
        <div className="flex shrink-0 items-center p-1">
          <GitBranchIcon
            className="h-4 w-4 shrink-0 text-muted-foreground"
            data-testid="pr-state-icon"
          />
        </div>
        <span className="truncate px-1 font-medium text-sm">{branchName}</span>
      </Link>
      <div className="flex h-9 shrink-0 items-center gap-2">
        {lifecycle ? (
          <span className="rounded-md border border-border bg-background px-2 py-1 font-medium text-muted-foreground text-xs">
            {PullRequestLifecycleLabels[lifecycle]}
          </span>
        ) : null}
        <OverflowMenu linkId={link.id} onUnlink={onUnlink} />
      </div>
    </div>
  );
}
