"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { AttachmentsRow } from "@repo/app/documents/components/attachments-row";
import { CollaborativeEditorBody } from "@repo/app/documents/components/collaborative-editor-body";
import {
  DocumentEditorDetails,
  getDocumentActivityMetadata,
} from "@repo/app/documents/components/document-editor-details";
import { DocumentMetadataBar } from "@repo/app/documents/components/document-metadata-bar";
import { DocumentFeedRail } from "@repo/app/documents/components/editor/document-feed-rail";
import { DocumentRoomEventListener } from "@repo/app/documents/components/editor/document-room-event-listener";
import { EditableDocumentTitle } from "@repo/app/documents/components/editor/editable-document-title";
import { EditorToolbarRow } from "@repo/app/documents/components/editor-toolbar-row";
import { deriveAnchorStatus } from "@repo/app/documents/components/feed-sidebar/anchor-status";
import { CommentPermalinkProvider } from "@repo/app/documents/components/feed-sidebar/comment-permalink-context";
import type { FeedArtifactType } from "@repo/app/documents/components/feed-sidebar/types";
import { MoveEntityDialog } from "@repo/app/documents/components/move-entity-dialog";
import { useCommentPermalinkBuilder } from "@repo/app/documents/components/use-comment-permalink-builder";
import { VersionActionsToolbar } from "@repo/app/documents/components/version-actions-toolbar";
import { useDocumentActions } from "@repo/app/documents/hooks/use-document-actions";
import { useDocumentContent } from "@repo/app/documents/hooks/use-document-content";
import { useDocumentMetadata } from "@repo/app/documents/hooks/use-document-metadata";
import { useEditorChrome } from "@repo/app/documents/hooks/use-editor-chrome";
import { useEditorSession } from "@repo/app/documents/hooks/use-editor-session";
import { useInlineEditMode } from "@repo/app/documents/hooks/use-inline-edit-mode";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { OptionalDocumentRoom } from "@repo/collaboration/client/optional-document-room";
import { InlinePresence } from "@repo/collaboration/client/presence";
import { scrollToAnchor } from "@repo/collaboration/client/scroll-to-anchor";
import { InlineEditEditorShell } from "@repo/design-system/components/ui/inline-edit-editor-shell";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@repo/design-system/components/ui/resizable";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import { Loader2Icon } from "lucide-react";
import {
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { VersionSelector } from "@/app/(authenticated)/[orgSlug]/implementation-plans/components/version-selector";
import { DocumentChatPanelWrapper } from "@/components/document-editor/document-chat-panel-wrapper";
import { useOrgSlug } from "@/hooks/use-org-slug";

export type ScaffoldSlotContext = {
  document: DocumentDetail;
  session: ReturnType<typeof useEditorSession>;
  contentController: ReturnType<typeof useDocumentContent>;
  metadata: ReturnType<typeof useDocumentMetadata>;
  actions: ReturnType<typeof useDocumentActions>;
  editMode: ReturnType<typeof useInlineEditMode>;
  chrome: ReturnType<typeof useEditorChrome>;
  isPending: boolean;
  showComments: boolean;
  setShowComments: (next: boolean) => void;
  versionDisplay: ReactNode;
  currentVersion: number;
  chatEnabled: boolean;
  feedEnabled: boolean;
};

export type DocumentEditorScaffoldProps = {
  document: DocumentDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;

  /** Merged into the scaffold's isPending */
  extraPending?: boolean;

  /** Passed through to useDocumentActions */
  redirectPath: string;

  /** ResizablePanelGroup autoSaveId — preserves per-type panel sizes */
  resizableAutoSaveId: string;

  /** FeedSidebar artifactType */
  feedArtifactType: FeedArtifactType;

  /** Hide repositories chip in metadata bar (Feature passes true) */
  hideRepositoriesInMetadataBar?: boolean;

  /** Delete dialog title (e.g. "PRD", "Implementation Plan", "Feature") */
  deleteDialogTitle: string;

  /** Optional teamId for MoveEntityDialog (Feature passes a value) */
  moveDialogTeamId?: string | null;

  /** Render-prop slots */
  renderHeader: (ctx: ScaffoldSlotContext) => ReactNode;
  detailsSections: (ctx: ScaffoldSlotContext) => ReactNode;
  /** Optional banner above the editor (PRD/Plan render GenerationStatusBanner) */
  banner?: (ctx: ScaffoldSlotContext) => ReactNode;
  /** Optional chat tab inside FeedSidebar when feed flag is on */
  renderChatTab?: (ctx: ScaffoldSlotContext) => ReactNode;
  /** Type-specific floating modals/pickers */
  floatingChildren?: (ctx: ScaffoldSlotContext) => ReactNode;
};

export function DocumentEditorScaffold({
  document,
  currentVersion,
  onVersionChange,
  extraPending = false,
  redirectPath,
  resizableAutoSaveId,
  feedArtifactType,
  hideRepositoriesInMetadataBar = false,
  deleteDialogTitle,
  moveDialogTeamId,
  renderHeader,
  detailsSections,
  banner,
  renderChatTab,
  floatingChildren,
}: Readonly<DocumentEditorScaffoldProps>) {
  const orgSlug = useOrgSlug();
  const searchParams = useSearchParamsValue();
  const commentThreadId = searchParams?.get("thread") ?? undefined;
  const chatFlag = useFeatureFlag("interactive-chat");
  const feedSidebarFlag = useFeatureFlag("comments-v2-feed-sidebar");
  const chatEnabled = chatFlag?.enabled === true;
  const feedEnabled = feedSidebarFlag?.enabled === true;

  const [showComments, setShowComments] = useState(true);

  // High-water mark of the newest version this client has already acted on —
  // either by publishing it locally or by handling a remote broadcast. Used to
  // suppress the publisher's own `document-version-published` echo: the saving
  // tab's mutation onSuccess already reseeds and toasts, but the broadcast can
  // round-trip back before the parent's `useDocument` refetch advances
  // `document.latestVersion`, so we cannot rely on the prop alone to recognize
  // a self-published version.
  const acknowledgedVersionRef = useRef(document.latestVersion);

  const session = useEditorSession({
    artifact: document,
    currentVersion,
  });
  const contentController = useDocumentContent({
    artifact: document,
    isLatestVersion: currentVersion === document.latestVersion,
    setEditorContent: session.setEditorContent,
    onVersionCreated: (updated) => {
      acknowledgedVersionRef.current = Math.max(
        acknowledgedVersionRef.current,
        updated.version.version
      );
      onVersionChange(updated.version.version);
    },
  });
  const metadata = useDocumentMetadata({ artifact: document });
  const actions = useDocumentActions({ artifact: document, redirectPath });
  const editMode = useInlineEditMode({
    readOnly: session.isViewingHistorical,
    editor: session.editor,
  });
  const chrome = useEditorChrome({ documentType: document.type });

  // React to remote version publishes: when another client publishes a new
  // version (or a server generation pipeline completes), `resetDocumentRoom`
  // clears the Y.Doc and broadcasts `document-version-published`. If the
  // current user was viewing the previous latest, advance them to the new
  // one and reseed the editor with the refetched content.
  const handleRemoteVersionPublished = useCallback(
    (updated: DocumentDetail) => {
      // Ignore anything not newer than what this client already knows about —
      // the artifact's current latest or a version we published/handled
      // ourselves. This is what keeps the publishing tab from re-toasting its
      // own save once the broadcast echoes back.
      const knownVersion = Math.max(
        document.latestVersion,
        acknowledgedVersionRef.current
      );
      if (updated.latestVersion <= knownVersion) {
        return;
      }
      acknowledgedVersionRef.current = updated.latestVersion;
      const wasViewingLatest = currentVersion === document.latestVersion;
      if (wasViewingLatest) {
        onVersionChange(updated.latestVersion);
        session.setEditorContent(updated.version.content ?? "");
      }
      toast(`A new version was published (v${updated.latestVersion}).`);
    },
    [
      currentVersion,
      document.latestVersion,
      onVersionChange,
      session.setEditorContent,
    ]
  );

  // Auto-reveal comments when threads reappear after being fully resolved.
  // Edge-triggered only (0 -> >0) so we don't override the user's manual toggle.
  const prevThreadCount = useRef(session.openThreadCount);
  useEffect(() => {
    if (prevThreadCount.current === 0 && session.openThreadCount > 0) {
      setShowComments(true);
    }
    prevThreadCount.current = session.openThreadCount;
  }, [session.openThreadCount]);

  const isPending =
    contentController.isSaving ||
    metadata.isUpdating ||
    actions.isDeleting ||
    actions.isRenaming ||
    extraPending;

  const versionDisplay = (
    <VersionSelector
      currentVersion={currentVersion}
      latestVersion={document.latestVersion}
      onVersionChange={onVersionChange}
    />
  );

  const activityMetadata = getDocumentActivityMetadata(document);
  const latestContentForAttachmentWarnings =
    getLatestContentForAttachmentWarnings({
      currentVersion,
      document,
      latestDraftContent: contentController.content,
    });

  // Card click → scroll the document editor to the thread's anchor for
  // anchored threads. No-op for floating / artifact-level threads — the
  // card's own composer-open behavior still runs regardless.
  const onCommentClick = useCallback(
    (thread: Parameters<typeof deriveAnchorStatus>[0]) => {
      if (deriveAnchorStatus(thread) === "anchored") {
        scrollToAnchor(thread.id);
      }
    },
    []
  );

  const buildPermalinkUrl = useCommentPermalinkBuilder({
    documentType: document.type,
    documentSlug: document.slug,
    orgSlug,
  });
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
    isPending,
    showComments,
    setShowComments,
    versionDisplay,
    currentVersion,
    chatEnabled,
    feedEnabled,
  };

  return (
    <>
      {renderHeader(ctx)}

      <ResizablePanelGroup
        autoSaveId={resizableAutoSaveId}
        direction="horizontal"
      >
        <ResizablePanel defaultSize={75} minSize={50}>
          <div className="flex h-full overflow-hidden bg-background">
            <OptionalDocumentRoom
              readOnly={session.isViewingHistorical}
              roomId={session.liveblocksRoomId}
            >
              {session.liveblocksRoomId ? (
                <DocumentRoomEventListener
                  documentId={document.id}
                  onRemoteVersionPublished={handleRemoteVersionPublished}
                />
              ) : null}
              <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
                <div
                  className={
                    session.isEditorReady
                      ? "hidden"
                      : "flex flex-1 items-center justify-center py-24"
                  }
                >
                  <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>

                <div
                  className={
                    session.isEditorReady
                      ? undefined
                      : "invisible h-0 overflow-hidden"
                  }
                >
                  {banner ? banner(ctx) : null}

                  <InlineEditEditorShell
                    expanded={editMode.isEditing || session.isViewingHistorical}
                    toolbar={
                      <EditorToolbarRow
                        leftContent={
                          <RichTextToolbar
                            className="border-0 bg-transparent p-0"
                            editor={session.editor}
                            hasLiveblocksExtension={
                              session.editorUsesLiveblocksContent
                            }
                            onPasteMarkdown={session.setEditorContent}
                            readOnly={!editMode.isEditing}
                          />
                        }
                        rightContent={
                          <>
                            {session.editorUsesLiveblocksContent && (
                              <Suspense fallback={null}>
                                <InlinePresence />
                              </Suspense>
                            )}
                            {versionDisplay}
                            <VersionActionsToolbar
                              canRestoreVersion={true}
                              canSaveVersion={
                                currentVersion === document.latestVersion
                              }
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
                              onToggleComments={setShowComments}
                              openThreadCount={session.openThreadCount}
                              showComments={showComments}
                              showCommentToggle={!feedEnabled}
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
                        session.editorUsesLiveblocksContent
                      }
                      externalToolbar
                      hasFeedSidebar={feedEnabled}
                      headerContent={
                        <div className="space-y-4 px-5 pt-10">
                          <EditableDocumentTitle
                            documentId={document.id}
                            initialTitle={document.title}
                          />
                          <DocumentMetadataBar
                            documentId={document.id}
                            documentType={document.type}
                            metadata={metadata}
                            showRepositories={!hideRepositoriesInMetadataBar}
                            tags={document.tags}
                          />
                          <AttachmentsRow
                            documentId={document.id}
                            latestContent={latestContentForAttachmentWarnings}
                          />
                        </div>
                      }
                      key={currentVersion}
                      liveblocksRoomId={session.liveblocksRoomId}
                      onBodyClick={editMode.enterEditMode}
                      onChange={contentController.updateContent}
                      onContentReady={session.handleEditorReady}
                      onEditorInstance={session.handleEditorInstance}
                      onOpenThreadCountChange={session.handleThreadCountChange}
                      placeholder="Add description..."
                      readOnly={!editMode.isEditing}
                      showComments={editMode.isEditing && showComments}
                      value={contentController.content}
                    />
                  </InlineEditEditorShell>
                </div>

                <DocumentEditorDetails
                  activity={activityMetadata}
                  documentId={document.id}
                >
                  {detailsSections(ctx)}
                </DocumentEditorDetails>
              </div>
              <CommentPermalinkProvider
                buildPermalinkUrl={buildPermalinkUrl}
                scrollToThreadId={commentThreadId}
              >
                <DocumentFeedRail
                  artifactType={feedArtifactType}
                  chatPanel={chatEnabled ? renderChatTab?.(ctx) : undefined}
                  currentVersion={currentVersion}
                  enabled={feedEnabled && !!session.liveblocksRoomId}
                  isViewingHistorical={session.isViewingHistorical}
                  latestVersion={document.latestVersion}
                  onClose={chrome.toggleMetadataPanel}
                  onCommentClick={onCommentClick}
                  organizationId={document.organizationId}
                  visible={chrome.showMetadataPanel}
                />
              </CommentPermalinkProvider>
            </OptionalDocumentRoom>
          </div>
        </ResizablePanel>

        <DocumentChatPanelWrapper
          document={document}
          enabled={!feedEnabled && chatEnabled}
          visible={chrome.showMetadataPanel}
        />
      </ResizablePanelGroup>

      <DeleteConfirmationDialog
        isPending={isPending}
        itemName={document.title}
        onConfirm={actions.handleDelete}
        onOpenChange={chrome.setShowDeleteDialog}
        open={chrome.showDeleteDialog}
        title={deleteDialogTitle}
      />

      <MoveEntityDialog
        entity={{ id: document.id, projectId: document.projectId }}
        onOpenChange={chrome.setShowMoveDialog}
        open={chrome.showMoveDialog}
        teamId={moveDialogTeamId ?? undefined}
      />

      {floatingChildren ? floatingChildren(ctx) : null}
    </>
  );
}

/**
 * Returns the content that attachment deletion warnings should inspect.
 * Historical views must use the saved latest version carried by the API, not
 * the selected historical `document.version.content` body.
 */
export function getLatestContentForAttachmentWarnings({
  currentVersion,
  document,
  latestDraftContent,
}: {
  currentVersion: number;
  document: Pick<
    DocumentDetail,
    "latestVersion" | "latestVersionContent" | "version"
  >;
  latestDraftContent: string;
}): string {
  if (currentVersion === document.latestVersion) {
    return latestDraftContent;
  }

  return document.latestVersionContent ?? "";
}
