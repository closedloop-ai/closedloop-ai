"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentEditorScaffold } from "@repo/app/documents/components/document-editor-scaffold";
import { useOrgSlug } from "@repo/app/documents/components/document-host-context";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { BranchesSection } from "@repo/app/documents/components/relationships/branches-section";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { PlanContextSection } from "@repo/app/documents/editors/implementation-plans/detail/components/plan-context-section";
import { PlanEditorHeader } from "@repo/app/documents/editors/implementation-plans/detail/components/plan-editor-header";
import { useDocumentPullRequest } from "@repo/app/documents/hooks/use-documents";
import type { OrgPathBuilder } from "@repo/navigation/navigation-adapter";
import { useOrgPath } from "@repo/navigation/use-org-path";

type PlanEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function PlanEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<PlanEditorProps>) {
  const plan = document;
  const orgSlug = useOrgSlug();
  const buildOrgPath = useOrgPath();

  const { data: pullRequestsData } = useDocumentPullRequest(plan.id);
  const pullRequests = pullRequestsData ?? [];

  const redirectPath = getPlanRedirectPath(plan, buildOrgPath);
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
      detailsSections={(ctx) => (
        <>
          <PlanContextSection
            active={ctx.isDetailsActive}
            planId={plan.id}
            projectId={plan.projectId}
          />
          <BranchesSection
            active={ctx.isDetailsActive}
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
        <PlanEditorHeader
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

function getPlanRedirectPath(
  plan: DocumentDetail,
  buildOrgPath: OrgPathBuilder
): string {
  const teamId = plan.project?.teams?.[0]?.id;
  if (teamId) {
    return buildOrgPath(`/teams/${teamId}/projects/${plan.project?.id ?? ""}`);
  }
  return buildOrgPath("/implementation-plans");
}
