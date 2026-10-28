"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { CustomFieldsSection } from "@repo/app/custom-fields/components/custom-fields-section";
import { DocumentEditorScaffold } from "@repo/app/documents/components/document-editor-scaffold";
import { useOrgSlug } from "@repo/app/documents/components/document-host-context";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { BranchesSection } from "@repo/app/documents/components/relationships/branches-section";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { ContextSection } from "@repo/app/documents/editors/issues/detail/components/context-section";
import { IssueEditorHeader } from "@repo/app/documents/editors/issues/detail/components/issue-editor-header";
import { PlanSection } from "@repo/app/documents/editors/issues/detail/components/plan-section";
import { useIssueState } from "@repo/app/documents/editors/issues/detail/use-issue-state";
import type { OrgPathBuilder } from "@repo/navigation/navigation-adapter";
import { useOrgPath } from "@repo/navigation/use-org-path";

type IssueEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function IssueEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<IssueEditorProps>) {
  const feature = document;
  const orgSlug = useOrgSlug();
  const buildOrgPath = useOrgPath();
  const { linkedPlanId } = useIssueState(feature);

  const redirectPath = getFeatureRedirectPath(feature, buildOrgPath);
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: feature.type,
    documentSlug: feature.slug,
    orgSlug,
  });

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="Issue"
      detailsSections={(ctx) => (
        <>
          <CustomFieldsSection
            active={ctx.isDetailsActive}
            entityId={feature.id}
            entityType={CustomFieldEntityType.Document}
            surface={ArtifactStatusEditSurface.Detail}
            values={feature.customFields}
          />
          <ContextSection
            active={ctx.isDetailsActive}
            featureId={feature.id}
            latestContent={ctx.latestContentForAttachmentWarnings}
            projectId={feature.projectId ?? undefined}
            renderedContent={ctx.selectedContentForAttachmentVisibility}
          />
          <PlanSection active={ctx.isDetailsActive} feature={feature} />
          <BranchesSection
            active={ctx.isDetailsActive}
            documentId={feature.id}
            planId={linkedPlanId}
            projectId={feature.projectId ?? ""}
          />
        </>
      )}
      document={feature}
      feedArtifactType={FeedArtifactType.Feature}
      hideRepositoriesInMetadataBar
      moveDialogTeamId={feature.project?.teams?.[0]?.id ?? null}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderHeader={(ctx) => (
        <IssueEditorHeader
          displayTitle={feature.title}
          feature={feature}
          onDelete={ctx.chrome.openDeleteDialog}
          onMoveToProject={ctx.chrome.openMoveDialog}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
        />
      )}
    />
  );
}

function getFeatureRedirectPath(
  feature: DocumentDetail,
  buildOrgPath: OrgPathBuilder
): string {
  const teamId = feature.project?.teams?.[0]?.id;
  const projectId = feature.project?.id;
  if (teamId && projectId) {
    return buildOrgPath(`/teams/${teamId}/projects/${projectId}`);
  }
  return buildOrgPath("/");
}
