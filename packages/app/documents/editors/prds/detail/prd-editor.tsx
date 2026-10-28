"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentEditorScaffold } from "@repo/app/documents/components/document-editor-scaffold";
import { useOrgSlug } from "@repo/app/documents/components/document-host-context";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { AssociatedArtifactsSection } from "@repo/app/documents/editors/prds/detail/components/associated-artifacts-section";
import { PRDEditorHeader } from "@repo/app/documents/editors/prds/detail/components/prd-editor-header";
import { useOrgPath } from "@repo/navigation/use-org-path";

type PRDEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

export function PRDEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<PRDEditorProps>) {
  const orgSlug = useOrgSlug();
  const buildOrgPath = useOrgPath();
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: document.type,
    documentSlug: document.slug,
    orgSlug,
  });
  const prd = document;

  const redirectPath = prd.project?.teams?.[0]?.id
    ? buildOrgPath(
        `/teams/${prd.project.teams[0].id}/projects/${prd.project.id}`
      )
    : buildOrgPath("/prds");

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="PRD"
      detailsSections={(ctx) => (
        <AssociatedArtifactsSection
          active={ctx.isDetailsActive}
          prdId={prd.id}
        />
      )}
      document={prd}
      feedArtifactType={FeedArtifactType.Prd}
      onVersionChange={onVersionChange}
      redirectPath={redirectPath}
      renderHeader={(ctx) => (
        <PRDEditorHeader
          onDelete={ctx.chrome.openDeleteDialog}
          onExport={ctx.actions.handleDownload}
          onMove={ctx.chrome.openMoveDialog}
          onRestoreVersion={ctx.contentController.restoreVersion}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          prd={prd}
          showRestore={ctx.session.isViewingHistorical}
        />
      )}
    />
  );
}
