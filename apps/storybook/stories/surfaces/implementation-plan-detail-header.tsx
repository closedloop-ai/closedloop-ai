"use client";

/**
 * Story substitute for `implementation-plan-detail.stories.tsx`'s header,
 * split into its own file to keep every file in this Surface under the
 * repo's 1,000-line ceiling (`noExcessiveLinesPerFile`), not for any reuse
 * reason. See that file's own doc comment for the Clerk walls this Surface
 * hits.
 *
 * `StoryPlanEditorHeader` is `PlanEditorHeader`
 * (`packages/app/documents/editors/implementation-plans/detail/components/plan-editor-header.tsx`),
 * copied verbatim except `useOrgSlug()` → `ORG_SLUG`. The real `Header`,
 * `FavoriteButton` and PR-link menu are unchanged.
 */

import type {
  DocumentDetail,
  PullRequestInfo,
} from "@repo/api/src/types/document";
import { resolveBranchDetailsNavigation } from "@repo/app/branches/lib/branch-details-navigation";
import { FavoriteButton } from "@repo/app/documents/components/favorite-button";
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
import {
  type BreadcrumbEntry,
  Header,
} from "@/app/(authenticated)/components/header";
import { ORG_SLUG } from "./app-shell";

// ---------------------------------------------------------------------------
// Story substitute: `PlanEditorHeader`.
// ---------------------------------------------------------------------------

// Branches on `branchNavigationEnabled` HERE — the flag read stays in
// `StoryPlanEditorHeader` — and passes `resolveBranchDetailsNavigation` a
// literal `rolloutEnabled` on each arm, matching the real
// `plan-editor-header.tsx`'s behavior without threading the flag's own
// boolean across the module boundary (no-threaded-feature-flag).
function resolveNavigationForPullRequest(
  pr: PullRequestInfo,
  branchNavigationEnabled: boolean
) {
  if (!pr.externalLinkId) {
    return null;
  }
  if (branchNavigationEnabled) {
    return resolveBranchDetailsNavigation({
      branchArtifactId: pr.externalLinkId,
      hasCompatibilityProviderFallback: pr.hasCompatibilityProviderFallback,
      productEligibility: pr.productEligibility,
      rolloutEnabled: true,
    });
  }
  return resolveBranchDetailsNavigation({
    branchArtifactId: pr.externalLinkId,
    hasCompatibilityProviderFallback: pr.hasCompatibilityProviderFallback,
    productEligibility: pr.productEligibility,
    rolloutEnabled: false,
  });
}

type StoryPlanEditorHeaderProps = {
  plan: DocumentDetail;
  pullRequests?: PullRequestInfo[] | null;
  onToggleMetadataPanel: () => void;
  onCopyMarkdown: () => void;
  onExportMarkdown: () => void;
  onMove: () => void;
  onDelete: () => void;
  showRestore?: boolean;
  onRestoreVersion?: () => void;
};

export function StoryPlanEditorHeader({
  plan,
  pullRequests,
  onToggleMetadataPanel,
  onCopyMarkdown,
  onExportMarkdown,
  onMove,
  onDelete,
  showRestore = false,
  onRestoreVersion,
}: StoryPlanEditorHeaderProps) {
  const orgSlug = ORG_SLUG;
  const branchNavigationEnabled = useFeatureFlagEnabledOptional(
    ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY
  );

  const breadcrumbs: BreadcrumbEntry[] = plan.project?.teams?.[0]?.id
    ? [
        {
          label: plan.project.teams[0].name,
          href: `/${orgSlug}/teams/${plan.project.teams[0].id}/projects`,
        },
        {
          label: plan.project.name,
          href: `/${orgSlug}/teams/${plan.project.teams[0].id}/projects/${plan.project.id}`,
        },
        { label: plan.title },
      ]
    : [
        { label: "Plans", href: `/${orgSlug}/implementation-plans` },
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
              const navigation = resolveNavigationForPullRequest(
                pr,
                branchNavigationEnabled
              );
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
                    <Link href={`/${orgSlug}${navigation.href}`}>{label}</Link>
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
