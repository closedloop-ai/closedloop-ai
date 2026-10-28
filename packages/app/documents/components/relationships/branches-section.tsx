"use client";

import {
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
} from "@repo/api/src/types/artifact";
import type { PullRequestInfo } from "@repo/api/src/types/document";
import { resolveBranchDetailsNavigation } from "@repo/app/branches/lib/branch-details-navigation";
import { OverflowMenu } from "@repo/app/documents/components/relationships/overflow-menu";
import {
  useDeleteArtifactLink,
  useResolvedArtifactLinks,
} from "@repo/app/documents/hooks/use-artifact-links";
import { useDocumentPullRequest } from "@repo/app/documents/hooks/use-documents";
import {
  getPullRequestLifecycle,
  PullRequestLifecycleLabels,
} from "@repo/app/github/lib/pull-request-lifecycle";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import { toast } from "@repo/design-system/components/ui/sonner";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { GitBranchIcon, PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { SelectPullRequestDialog } from "./select-pr-dialog";

type BranchesSectionProps = {
  documentId: string;
  active?: boolean;
  projectId: string;
  planId: string | null;
};

export function BranchesSection({
  documentId,
  active = true,
  projectId,
  planId,
}: Readonly<BranchesSectionProps>) {
  const [showSelectPr, setShowSelectPr] = useState(false);
  const [isOpen, setIsOpen] = useState(true);
  const branchNavigationEnabled = useFeatureFlagEnabledOptional(
    ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY
  );
  const { data: resolvedLinks = [] } = useResolvedArtifactLinks(documentId, {
    enabled: active,
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

  const branchLinks = resolvedLinks.filter(
    (link) => link.target.type === ArtifactType.Branch
  );

  const hasBranches = branchLinks.length > 0;
  const { data: pullRequests = [] } = useDocumentPullRequest(documentId, {
    enabled: active && isOpen && hasBranches,
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
                rolloutEnabled={branchNavigationEnabled}
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
                <Button
                  onClick={() => setShowSelectPr(true)}
                  size="sm"
                  variant="outline"
                >
                  Select Existing PR
                </Button>
              </div>
            </div>
          </div>
        ))}
      <SelectPullRequestDialog
        documentId={documentId}
        onOpenChange={setShowSelectPr}
        open={active && showSelectPr}
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
  rolloutEnabled: boolean;
};

export function BranchRow({
  link,
  onUnlink,
  pullRequest,
  rolloutEnabled,
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
  const navigation = resolveBranchDetailsNavigation({
    branchArtifactId: branchEndpoint.id,
    hasCompatibilityProviderFallback:
      branchEndpoint.hasCompatibilityProviderFallback,
    productEligibility: branchEndpoint.productEligibility,
    rolloutEnabled,
  });
  const label = (
    <>
      <div className="flex shrink-0 items-center p-1">
        <GitBranchIcon
          className="h-4 w-4 shrink-0 text-muted-foreground"
          data-testid="pr-state-icon"
        />
      </div>
      <span className="truncate px-1 font-medium text-sm">{branchName}</span>
    </>
  );

  return (
    <div className="flex items-center gap-4 px-2 py-1">
      {navigation.href ? (
        <Link
          className="flex min-w-0 flex-1 items-center gap-1 rounded-md hover:bg-accent"
          href={buildOrgPath(navigation.href)}
        >
          {label}
        </Link>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
          {label}
        </div>
      )}
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
