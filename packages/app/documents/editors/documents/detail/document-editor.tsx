"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  DocumentEditorScaffold,
  type ScaffoldSlotContext,
} from "@repo/app/documents/components/document-editor-scaffold";
import { useOrgSlug } from "@repo/app/documents/components/document-host-context";
import { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { DocumentEditorHeader } from "@repo/app/documents/editors/documents/detail/components/document-editor-header";
import { useOrgPath } from "@repo/navigation/use-org-path";

type DocumentEditorProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

/**
 * The org-level Document (DOC) editor (ISS-4382).
 *
 * DOC is the generic evergreen-document subtype created from the Documents
 * index (FEA-3949 / FEA-4345). It reuses the shared {@link DocumentEditorScaffold}
 * — the same collaborative rich-text editor, version history, comments/feed
 * rail, metadata bar, delete, and move machinery that back the PRD and
 * Implementation Plan editors — but supplies a lean header with no generation
 * pipeline (no Approve/Execute/Regenerate/Evaluate), because a plain document
 * has no AI-authoring workflow.
 *
 * A DOC deliberately omits two PRD/Plan controls: **Move** (the API files a DOC
 * into a project since ISS-12858; whether this header offers it is ISS-12859's
 * Details work) and the standalone **Rename** dialog (its "File name" field is
 * meaningless on a project-less document, and the
 * scaffold already renders an inline `EditableDocumentTitle` that owns renaming
 * the title in place). It opens straight into edit mode on a fresh blank
 * version because a plain document's whole job is the empty page.
 */
export function DocumentEditor({
  document,
  currentVersion,
  onVersionChange,
}: Readonly<DocumentEditorProps>) {
  const orgSlug = useOrgSlug();
  const buildOrgPath = useOrgPath();
  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: document.type,
    documentSlug: document.slug,
    orgSlug,
  });

  return (
    <DocumentEditorScaffold
      buildPermalinkUrl={buildPermalinkUrl}
      currentVersion={currentVersion}
      deleteDialogTitle="Document"
      detailsSections={() => null}
      document={document}
      // A plain document's body is the document itself, not a "description".
      emptyContentPlaceholder="Start writing..."
      // Documents get their own feed width/source-filter scope; they must not
      // share the PRD's persisted rail layout.
      feedArtifactType={FeedArtifactType.Doc}
      hideMoveAction
      // Documents have no repositories snapshot; suppress the permanent
      // "No repositories" label an org-level artifact would always show.
      hideRepositoriesInMetadataBar
      onVersionChange={onVersionChange}
      redirectPath={buildOrgPath("/documents")}
      renderHeader={(ctx: ScaffoldSlotContext) => (
        <DocumentEditorHeader
          document={document}
          isMetadataPanelOpen={ctx.chrome.showMetadataPanel}
          onCopyMarkdown={ctx.actions.handleCopy}
          onDelete={ctx.chrome.openDeleteDialog}
          onExportMarkdown={ctx.actions.handleDownload}
          onRestoreVersion={ctx.contentController.restoreVersion}
          onToggleMetadataPanel={ctx.chrome.toggleMetadataPanel}
          showRestore={ctx.session.isViewingHistorical}
        />
      )}
      // A brand-new DOC lands on an empty latest version; open it in edit mode
      // with the cursor placed so the blank page is immediately writable.
      startInEditModeWhenEmpty
    />
  );
}
