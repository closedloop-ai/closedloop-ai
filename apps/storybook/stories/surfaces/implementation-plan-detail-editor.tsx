"use client";

/**
 * `StoryPlanEditor` for `implementation-plan-detail.stories.tsx`, split
 * into its own file to keep every file in this Surface under the repo's
 * 1,000-line ceiling (`noExcessiveLinesPerFile`), not for any reuse reason.
 * See that file's own doc comment for the Clerk walls this Surface hits.
 *
 * `StoryPlanEditor` is the real route's own `plan-editor.tsx` copied
 * verbatim except: its own `useOrgSlug()` → `ORG_SLUG`, and its
 * `PlanEditorHeader` → `StoryPlanEditorHeader` (from
 * `./implementation-plan-detail-header`).
 *
 * Every other piece composed here (`DocumentEditorScaffold`,
 * `PlanContextSection`, `BranchesSection`) is the real, unmodified
 * `packages/app` export, confirmed Clerk-free by reading its own imports.
 */

import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentEditorScaffold } from "@repo/app/documents/components/document-editor-scaffold";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { BranchesSection } from "@repo/app/documents/components/relationships/branches-section";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { PlanContextSection } from "@repo/app/documents/editors/implementation-plans/detail/components/plan-context-section";
import { useDocumentPullRequest } from "@repo/app/documents/hooks/use-documents";
import { ORG_SLUG } from "./app-shell";
import { StoryPlanEditorHeader } from "./implementation-plan-detail-header";

function getPlanRedirectPath(plan: DocumentDetail, orgSlug: string): string {
  const teamId = plan.project?.teams?.[0]?.id;
  if (teamId) {
    return `/${orgSlug}/teams/${teamId}/projects/${plan.project?.id ?? ""}`;
  }
  return `/${orgSlug}/implementation-plans`;
}

type StoryPlanEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function StoryPlanEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<StoryPlanEditorProps>) {
  const plan = document;
  const orgSlug = ORG_SLUG;

  const { data: pullRequestsData } = useDocumentPullRequest(plan.id);
  const pullRequests = pullRequestsData ?? [];

  const redirectPath = getPlanRedirectPath(plan, orgSlug);
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: plan.type,
    documentSlug: plan.slug,
    orgSlug,
  });

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="Implementation Plan"
      detailsSections={() => (
        <>
          <PlanContextSection planId={plan.id} projectId={plan.projectId} />
          <BranchesSection
            documentId={plan.id}
            planId={plan.id}
            projectId={plan.projectId ?? ""}
          />
        </>
      )}
      document={plan}
      feedArtifactType={FeedArtifactType.Plan}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderHeader={(ctx) => (
        <StoryPlanEditorHeader
          onCopyMarkdown={ctx.actions.handleCopy}
          onDelete={ctx.chrome.openDeleteDialog}
          onExportMarkdown={ctx.actions.handleDownload}
          onMove={ctx.chrome.openMoveDialog}
          onRestoreVersion={ctx.contentController.restoreVersion}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          plan={plan}
          pullRequests={pullRequests}
          showRestore={ctx.session.isViewingHistorical}
        />
      )}
    />
  );
}
