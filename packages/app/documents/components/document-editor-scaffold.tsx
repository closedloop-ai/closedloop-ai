"use client";

import { DOC_SYNC_EDITOR_FLAG_KEY } from "@repo/api/src/types/doc-sync-editor-flag";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { AttachmentsRow } from "@repo/app/documents/components/attachments-row";
import { CollaborativeEditorBody } from "@repo/app/documents/components/collaborative-editor-body";
import { DocumentEditorDetails } from "@repo/app/documents/components/document-editor-details";
import { useDocumentHostDeleteRedirectPath } from "@repo/app/documents/components/document-host-context";
import { DocumentMetadataBar } from "@repo/app/documents/components/document-metadata-bar";
import { DocumentRichTextToolbar } from "@repo/app/documents/components/document-rich-text-toolbar";
import { DocumentFeedRail } from "@repo/app/documents/components/editor/document-feed-rail";
import { DocumentRoomEventListener } from "@repo/app/documents/components/editor/document-room-event-listener";
import { EditableDocumentTitle } from "@repo/app/documents/components/editor/editable-document-title";
import {
  EditorBodyStatusRegion,
  editorBodyClassName,
} from "@repo/app/documents/components/editor-body-status-region";
import { EditorToolbarRow } from "@repo/app/documents/components/editor-toolbar-row";
import { deriveAnchorStatus } from "@repo/app/documents/components/feed-sidebar/anchor-status";
import { CommentPermalinkProvider } from "@repo/app/documents/components/feed-sidebar/comment-permalink-context";
import type { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { MoveEntityDialog } from "@repo/app/documents/components/move-entity-dialog";
import { VersionActionsToolbar } from "@repo/app/documents/components/version-actions-toolbar";
import { useAnchorRevealWhenEditorReady } from "@repo/app/documents/hooks/use-anchor-reveal-when-editor-ready";
import { useDocumentActions } from "@repo/app/documents/hooks/use-document-actions";
import { useDocumentContent } from "@repo/app/documents/hooks/use-document-content";
import { useDocumentMetadata } from "@repo/app/documents/hooks/use-document-metadata";
import { useDocumentVersionSignals } from "@repo/app/documents/hooks/use-document-version-signals";
import { useEditorChrome } from "@repo/app/documents/hooks/use-editor-chrome";
import { useEditorSession } from "@repo/app/documents/hooks/use-editor-session";
import { useInlineEditMode } from "@repo/app/documents/hooks/use-inline-edit-mode";
import { useRemoteVersionPublished } from "@repo/app/documents/hooks/use-remote-version-published";
import { bodyLeadsWithTitleHeading } from "@repo/app/documents/lib/leading-title-heading";
import { ArtifactDetailShell } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import { ArtifactTab } from "@repo/app/shared/components/artifact-detail-shell/artifact-tab";
import { useArtifactDetailTabRoute } from "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  ARTIFACT_DETAIL_TABS,
  ArtifactDetailTab,
} from "@repo/app/shared/lib/artifact-detail-tab";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import { DocSyncRoom } from "@repo/collaboration/client/doc-sync-room";
import { OptionalDocumentRoom } from "@repo/collaboration/client/optional-document-room";
import { InlinePresence } from "@repo/collaboration/client/presence";
import { InlineEditEditorShell } from "@repo/design-system/components/ui/inline-edit-editor-shell";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  getLatestContentForAttachmentWarnings,
  getSelectedContentForAttachmentVisibility,
  resolveActiveRoomId,
} from "./document-editor-scaffold-helpers";
import { DocumentSessionsTab } from "./document-sessions-tab";
import { DocumentShellActivity } from "./document-shell-activity";
import { VersionSelector } from "./version-selector";

export type ScaffoldSlotContext = {
  document: DocumentDetail;
  session: ReturnType<typeof useEditorSession>;
  contentController: ReturnType<typeof useDocumentContent>;
  metadata: ReturnType<typeof useDocumentMetadata>;
  actions: ReturnType<typeof useDocumentActions>;
  editMode: ReturnType<typeof useInlineEditMode>;
  chrome: ReturnType<typeof useEditorChrome>;
  isDetailsActive: boolean;
  versionDisplay: ReactNode;
  currentVersion: number;
  /**
   * The content an attachment decision must be made against: the live draft on
   * the latest version, the saved body when reading history. Published here so a
   * details-section slot (the issue rail's Context section) reaches the SAME
   * derivation `AttachmentsRow` uses, instead of re-reading `latestVersionContent`
   * and disagreeing with the row about an unsaved paste (ISS-8036).
   */
  latestContentForAttachmentWarnings: string;
  /**
   * The content whose rendered inline images the panels HIDE: the live draft on
   * the latest version, the SELECTED version's body when reading history. Split
   * from `latestContentForAttachmentWarnings` because the two questions have
   * different answers on a historical view (ISS-8036 review).
   */
  selectedContentForAttachmentVisibility: string;
};

export type DocumentEditorScaffoldProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;

  /**
   * Per-thread comment permalink-URL factory, or `undefined` to disable the
   * Copy Link affordance. Injected by the surface adapter so this shared
   * scaffold never threads a raw org slug and never reads
   * `window.location.origin` itself — the web adapter builds a canonical
   * URL (via `useCommentPermalinkBuilder`, which owns the org slug and
   * browser origin), and the Desktop renderer can supply its own builder or
   * omit it entirely (its origin is not a shareable web origin).
   */
  buildPermalinkUrl?: (threadId: string) => string;

  /** Passed through to useDocumentActions */
  redirectPath: string;

  /** FeedSidebar artifactType */
  feedArtifactType: FeedArtifactType;

  /** Hide repositories chip in metadata bar (Feature passes true) */
  hideRepositoriesInMetadataBar?: boolean;

  /** Delete dialog title (e.g. "PRD", "Implementation Plan", "Issue") */
  deleteDialogTitle: string;

  /** Optional teamId for MoveEntityDialog (Feature passes a value) */
  moveDialogTeamId?: string | null;

  /**
   * Open straight into edit mode on first mount when the current version is the
   * latest and its content is empty (ISS-4382). The org-level Document editor
   * passes true so a brand-new blank DOC lands with the cursor in the body
   * instead of a near-blank read-only screen; the scaffold still gates this on
   * the latest-and-empty check, so a populated or historical version is
   * unaffected.
   */
  startInEditModeWhenEmpty?: boolean;

  /**
   * Placeholder shown in an empty editor body. Defaults to "Add description..."
   * which fits a PRD/Plan; the DOC editor overrides it because a plain
   * document's body is not a description.
   */
  emptyContentPlaceholder?: string;

  /**
   * Hide the "Move..." action / dialog (ISS-4382). The DOC editor sets it: the
   * API files a DOC into a project since ISS-12858, and whether its header
   * offers Move is ISS-12859's Details work.
   */
  hideMoveAction?: boolean;

  /** Render-prop slots */
  renderHeader: (ctx: ScaffoldSlotContext) => ReactNode;
  detailsSections: (ctx: ScaffoldSlotContext) => ReactNode;
};

export function DocumentEditorScaffold({
  document,
  currentVersion,
  onVersionChange,
  buildPermalinkUrl,
  redirectPath,
  feedArtifactType,
  hideRepositoriesInMetadataBar = false,
  deleteDialogTitle,
  moveDialogTeamId,
  startInEditModeWhenEmpty = false,
  emptyContentPlaceholder = "Add description...",
  hideMoveAction = false,
  renderHeader,
  detailsSections,
}: Readonly<DocumentEditorScaffoldProps>) {
  // Gate the Liveblocks room connection on the user/org context being ready
  // (FEA-2404). The parent CollaborationProviderWrapper's LiveblocksProvider
  // is already mounted before `/me` resolves; if a document's room connects
  // before then, its auth callback fires before Clerk/org has hydrated and can
  // exhaust Liveblocks' hardcoded 10s auth timeout, surfacing as a real-prod
  // "Authentication failed: Timed out during auth" RUM error. Deferring the
  // room until `currentUser` resolves means the room connects exactly once,
  // with context ready. `useCurrentUser` is already fetched by the wrapper, so
  // TanStack Query dedupes this call.
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const route = useArtifactDetailTabRoute(DOCUMENT_ARTIFACT_ROUTE_CONFIG);
  const searchParams = useSearchParamsValue();
  const commentThreadId = searchParams?.get("thread") ?? undefined;
  // PLN-2189 T-3.2: the editor tree's read of the transport switch (the route
  // prewarm reads it separately). Descendants branch on the mounted
  // `DocSyncRoom`, never on the flag.
  const docSyncEditorEnabled = useFeatureFlagEnabled(DOC_SYNC_EDITOR_FLAG_KEY);

  const session = useEditorSession({
    artifact: document,
    currentVersion,
  });
  const { acknowledgeVersion, handleRemoteVersionPublished } =
    useRemoteVersionPublished({
      document,
      currentVersion,
      onVersionChange,
      setEditorContent: session.setEditorContent,
    });
  useDocumentVersionSignals({
    document,
    onRemoteVersionPublished: handleRemoteVersionPublished,
  });
  // Only connect the collaborative room once the user/org context is ready.
  // Until then treat the document as room-less — an already-supported state
  // that OptionalDocumentRoom renders without a RoomProvider — so no auth call
  // races page mount (FEA-2404). Extracted to a pure helper for unit testing.
  const activeRoomId = resolveActiveRoomId({
    liveblocksRoomId: session.liveblocksRoomId,
    isUserLoading,
    hasCurrentUser: Boolean(currentUser),
  });
  // The editor only reads content from the Liveblocks Y.Doc (and renders
  // presence) when the room is actually connected. Derive this from
  // `activeRoomId`, not the raw `session` flag, so descendants that call
  // Liveblocks room hooks (RichTextEditorHost's Liveblocks variant,
  // InlinePresence) never mount before the RoomProvider does during the
  // currentUser-loading window (FEA-2404).
  const editorUsesLiveblocksContent =
    session.editorUsesLiveblocksContent && Boolean(activeRoomId);
  const contentController = useDocumentContent({
    artifact: document,
    isLatestVersion: currentVersion === document.latestVersion,
    setEditorContent: session.setEditorContent,
    onVersionCreated: (updated) => {
      acknowledgeVersion(updated.version.version);
      onVersionChange(updated.version.version);
    },
  });
  const metadata = useDocumentMetadata({ artifact: document });

  const hostDeleteRedirectPath = useDocumentHostDeleteRedirectPath();
  const actions = useDocumentActions({
    artifact: document,
    redirectPath: hostDeleteRedirectPath ?? redirectPath,
  });
  // A brand-new DOC lands on its latest version with empty content; open it
  // straight into edit mode with a placed cursor so the blank page is usable
  // immediately, instead of a read-only near-blank screen (ISS-4382). Gated on
  // the actual latest-and-empty state so a populated or historical version is
  // never force-edited.
  const isLatestVersion = currentVersion === document.latestVersion;
  const isContentEmpty = (document.version.content ?? "").trim().length === 0;
  const editMode = useInlineEditMode({
    readOnly: session.isViewingHistorical,
    editor: session.editor,
    isEditorReady: session.isEditorReady,
    initialEditing:
      startInEditModeWhenEmpty && isLatestVersion && isContentEmpty,
  });
  const chrome = useEditorChrome({ documentType: document.type });

  // ISS-5006: the templates seed the body with an H1 equal to the title, and
  // the header above renders that same title independently, so the string
  // landed twice, back to back, at two sizes. Hide the repeat in the read view
  // only. In edit mode the author sees and edits the real document, and nothing
  // here rewrites the stored content.
  const hideLeadingTitleHeading =
    !editMode.isEditing &&
    bodyLeadsWithTitleHeading(contentController.content, document.title);

  const isPending =
    contentController.isSaving || metadata.isUpdating || actions.isDeleting;

  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={document.latestVersion}
      onVersionChange={onVersionChange}
    />
  );

  const latestContentForAttachmentWarnings =
    getLatestContentForAttachmentWarnings({
      currentVersion,
      document,
      latestDraftContent: contentController.content,
    });
  const selectedContentForAttachmentVisibility =
    getSelectedContentForAttachmentVisibility({
      currentVersion,
      document,
      latestDraftContent: contentController.content,
    });

  // Card click → scroll the document editor to the thread's anchor for
  // anchored threads. No-op for floating / artifact-level threads — the
  // card's own composer-open behavior still runs regardless.
  const revealAnchor = useAnchorRevealWhenEditorReady(session.isEditorReady);
  const onCommentClick = useCallback(
    (thread: Parameters<typeof deriveAnchorStatus>[0]) => {
      if (deriveAnchorStatus(thread) === "anchored") {
        route.selectTabThenReveal(ArtifactDetailTab.Artifact, () => {
          revealAnchor(thread.id);
        });
      }
    },
    [route.selectTabThenReveal, revealAnchor]
  );

  // Force the metadata panel open on initial mount when a permalink is
  // being resolved — otherwise users whose panel preference is "closed"
  // (persisted in localStorage by useEditorChrome) get a silent no-op:
  // no scroll, no highlight, no missing-thread banner. Runs once per
  // commentThreadId.
  const lastResolvedPermalinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (commentThreadId === undefined) {
      return;
    }
    if (lastResolvedPermalinkRef.current === commentThreadId) {
      return;
    }
    lastResolvedPermalinkRef.current = commentThreadId;
    chrome.setShowMetadataPanel(true);
  }, [commentThreadId, chrome.setShowMetadataPanel]);

  const ctx: ScaffoldSlotContext = {
    document,
    session,
    contentController,
    metadata,
    actions,
    editMode,
    chrome,
    isDetailsActive: route.activeTab === ArtifactDetailTab.Details,
    versionDisplay,
    currentVersion,
    latestContentForAttachmentWarnings,
    selectedContentForAttachmentVisibility,
  };

  const roomBody = (
    <>
      {activeRoomId ? (
        <DocumentRoomEventListener
          documentId={document.id}
          onRemoteVersionPublished={handleRemoteVersionPublished}
        />
      ) : null}
      <ArtifactDetailShell
        activeTab={route.activeTab}
        comments={
          <CommentPermalinkProvider
            buildPermalinkUrl={buildPermalinkUrl}
            scrollToThreadId={commentThreadId}
          >
            <DocumentFeedRail
              artifactType={feedArtifactType}
              currentVersion={currentVersion}
              documentId={document.id}
              documentType={document.type}
              enabled={!!activeRoomId}
              isViewingHistorical={session.isViewingHistorical}
              latestVersion={document.latestVersion}
              onClose={chrome.toggleMetadataPanel}
              onCommentClick={onCommentClick}
              organizationId={document.organizationId}
              visible={chrome.showMetadataPanel}
            />
          </CommentPermalinkProvider>
        }
        keepMountedTabs={[
          ArtifactDetailTab.Artifact,
          ArtifactDetailTab.Details,
        ]}
        key={document.id}
        onActivePanelReady={route.onActivePanelReady}
        onActiveTabChange={route.setActiveTab}
        panels={{
          [ArtifactDetailTab.Artifact]: (
            <ArtifactTab
              canvas={
                <div className="min-w-0 flex-1">
                  <EditorBodyStatusRegion
                    hasTimedOut={session.hasEditorReadyTimedOut}
                    isEditorReady={session.isEditorReady}
                  />

                  <div className={editorBodyClassName(session.isEditorReady)}>
                    <InlineEditEditorShell
                      expanded={
                        editMode.isEditing || session.isViewingHistorical
                      }
                      toolbar={
                        <EditorToolbarRow
                          leftContent={
                            <DocumentRichTextToolbar
                              className="border-0 bg-transparent p-0"
                              editor={session.editor}
                              hasLiveblocksExtension={
                                editorUsesLiveblocksContent
                              }
                              onPasteMarkdown={session.setEditorContent}
                              readOnly={!editMode.isEditing}
                            />
                          }
                          rightContent={
                            <>
                              {editorUsesLiveblocksContent && (
                                <Suspense fallback={null}>
                                  <InlinePresence />
                                </Suspense>
                              )}
                              {versionDisplay}
                              <VersionActionsToolbar
                                canRestoreVersion={true}
                                canSaveVersion={isLatestVersion}
                                hasUnsavedChanges={
                                  contentController.hasUnsavedChanges
                                }
                                isRestoring={isPending}
                                isSaving={contentController.isSaving}
                                onRestoreVersion={
                                  contentController.restoreVersion
                                }
                                onSaveVersion={() =>
                                  contentController.saveContent(
                                    undefined,
                                    false,
                                    editMode.exitEditMode
                                  )
                                }
                              />
                            </>
                          }
                        />
                      }
                    >
                      <CollaborativeEditorBody
                        currentVersion={currentVersion}
                        documentId={document.id}
                        editorUsesLiveblocksContent={
                          editorUsesLiveblocksContent
                        }
                        externalToolbar
                        headerContent={
                          <div className="space-y-4 px-5 pt-10">
                            <EditableDocumentTitle
                              documentId={document.id}
                              initialTitle={document.title}
                            />
                          </div>
                        }
                        hideLeadingTitleHeading={hideLeadingTitleHeading}
                        key={currentVersion}
                        liveblocksRoomId={activeRoomId}
                        onBodyClick={editMode.enterEditMode}
                        onChange={contentController.updateContent}
                        onContentReady={session.handleEditorReady}
                        onEditorInstance={session.handleEditorInstance}
                        placeholder={emptyContentPlaceholder}
                        readOnly={!editMode.isEditing}
                        showComments={editMode.isEditing}
                        value={contentController.content}
                      />
                    </InlineEditEditorShell>
                  </div>
                </div>
              }
            />
          ),
          [ArtifactDetailTab.Sessions]: (
            <DocumentSessionsTab document={document} />
          ),
          [ArtifactDetailTab.Details]: (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <DocumentEditorDetails
                active={route.activeTab === ArtifactDetailTab.Details}
                documentId={document.id}
              >
                <DocumentMetadataBar
                  documentId={document.id}
                  documentType={document.type}
                  metadata={metadata}
                  showRepositories={!hideRepositoriesInMetadataBar}
                  tags={document.tags}
                />
                <AttachmentsRow
                  active={ctx.isDetailsActive}
                  documentId={document.id}
                  latestContent={latestContentForAttachmentWarnings}
                  renderedContent={selectedContentForAttachmentVisibility}
                />
                {detailsSections(ctx)}
              </DocumentEditorDetails>
            </div>
          ),
          [ArtifactDetailTab.Activity]: (
            <DocumentShellActivity document={document} />
          ),
        }}
        tabs={ARTIFACT_DETAIL_TABS}
      />
    </>
  );

  return (
    <>
      {renderHeader(ctx)}

      <OptionalDocumentRoom
        readOnly={session.isViewingHistorical}
        roomId={activeRoomId}
      >
        {docSyncEditorEnabled && activeRoomId ? (
          <DocSyncRoom
            readOnly={session.isViewingHistorical}
            roomId={activeRoomId}
          >
            {roomBody}
          </DocSyncRoom>
        ) : (
          roomBody
        )}
      </OptionalDocumentRoom>

      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={document.title}
        onConfirm={actions.handleDelete}
        onOpenChange={chrome.setShowDeleteDialog}
        open={chrome.showDeleteDialog}
        title={deleteDialogTitle}
      />

      {hideMoveAction ? null : (
        <MoveEntityDialog
          entity={{ id: document.id, projectId: document.projectId }}
          onOpenChange={chrome.setShowMoveDialog}
          open={chrome.showMoveDialog}
          teamId={moveDialogTeamId ?? undefined}
        />
      )}
    </>
  );
}

const DOCUMENT_ARTIFACT_ROUTE_CONFIG = { tabs: ARTIFACT_DETAIL_TABS };
