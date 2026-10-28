"use client";

import type {
  DocumentWithProject,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import {
  type BranchDetailsNavigation,
  resolveBranchDetailsNavigation,
} from "@repo/app/branches/lib/branch-details-navigation";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
import {
  type BreadcrumbEntry,
  Header,
} from "@repo/app/documents/editors/shared/header";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Link } from "@repo/navigation/link";
import { useOrgPath } from "@repo/navigation/use-org-path";
import {
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  GitPullRequestIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RotateCcwIcon,
  TrashIcon,
} from "lucide-react";

type PlanEditorHeaderProps = {
  plan: DocumentWithProject;
  pullRequests?: PullRequestInfo[] | null;
  onToggleMetadataPanel: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onMove: () => void;
  onDelete: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
};

export function PlanEditorHeader({
  plan,
  pullRequests,
  onToggleMetadataPanel,
  onCopyMarkdown,
  onExportMarkdown,
  onMove,
  onDelete,
  showRestore = false,
  onRestoreVersion,
}: PlanEditorHeaderProps) {
  const buildOrgPath = useOrgPath();
  const branchNavigationEnabled = useFeatureFlagEnabledOptional(
    ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY
  );

  const breadcrumbs: BreadcrumbEntry[] = plan.project?.teams?.[0]?.id
    ? [
        {
          label: plan.project.teams[0].name,
          href: buildOrgPath(`/teams/${plan.project.teams[0].id}/projects`),
        },
        {
          label: plan.project.name,
          href: buildOrgPath(
            `/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`
          ),
        },
        { label: plan.title },
      ]
    : [
        { label: "Plans", href: buildOrgPath("/implementation-plans") },
        { label: plan.title },
      ];

  const overflowMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label="More options" size="icon" variant="ghost">
          <MoreHorizontalIcon className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        {pullRequests && pullRequests.length > 0 ? (
          <>
            {pullRequests.map((pr) => {
              let navigation: BranchDetailsNavigation | null = null;
              if (pr.externalLinkId) {
                const input = {
                  branchArtifactId: pr.externalLinkId,
                  hasCompatibilityProviderFallback:
                    pr.hasCompatibilityProviderFallback,
                  productEligibility: pr.productEligibility,
                };
                if (branchNavigationEnabled) {
                  navigation = resolveBranchDetailsNavigation({
                    ...input,
                    rolloutEnabled: true,
                  });
                } else {
                  navigation = resolveBranchDetailsNavigation({
                    ...input,
                    rolloutEnabled: false,
                  });
                }
              }
              const label = (
                <>
                  <GitPullRequestIcon className="h-4 w-4" />
                  {pr.repoFullName ? `${pr.repoFullName} ` : ""}
                  PR #{pr.number}
                </>
              );
              return (
                <DropdownMenuItem
                  asChild={Boolean(navigation?.href)}
                  disabled={!navigation?.href}
                  key={pr.id}
                >
                  {navigation?.href ? (
                    <Link href={buildOrgPath(`${navigation.href}`)}>
                      {label}
                    </Link>
                  ) : (
                    <span>{label}</span>
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onClick={() => onExportMarkdown()}>
          <DownloadIcon className="h-4 w-4" />
          Export Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCopyMarkdown()}>
          <CopyIcon className="h-4 w-4" />
          Copy Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMove()}>
          <FolderIcon className="h-4 w-4" />
          Move...
        </DropdownMenuItem>
        {showRestore ? (
          <DropdownMenuItem onClick={() => onRestoreVersion?.()}>
            <RotateCcwIcon className="h-4 w-4" />
            Restore Version
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onDelete()} variant="destructive">
          <TrashIcon className="h-4 w-4" />
          Delete Plan
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Header
      afterBreadcrumbs={<FavoriteButton artifactId={plan.id} />}
      breadcrumbs={breadcrumbs}
      moreMenu={overflowMenu}
    >
      <Button
        aria-label="Toggle chat panel"
        onClick={() => onToggleMetadataPanel()}
        size="icon"
        title="Toggle chat panel"
        variant="ghost"
      >
        <PanelRightIcon className="h-4 w-4" />
      </Button>
    </Header>
  );
}
