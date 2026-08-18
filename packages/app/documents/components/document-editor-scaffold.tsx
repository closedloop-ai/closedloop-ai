"use client";

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
import { VersionActionsToolbar } from "@repo/app/documents/components/version-actions-toolbar";
import { useDocumentActions } from "@repo/app/documents/hooks/use-document-actions";
import { useDocumentContent } from "@repo/app/documents/hooks/use-document-content";
import { useDocumentMetadata } from "@repo/app/documents/hooks/use-document-metadata";
import { useEditorChrome } from "@repo/app/documents/hooks/use-editor-chrome";
import { useEditorSession } from "@repo/app/documents/hooks/use-editor-session";
import { useInlineEditMode } from "@repo/app/documents/hooks/use-inline-edit-mode";
import { bodyLeadsWithTitleHeading } from "@repo/app/documents/lib/leading-title-heading";
import { DeleteConfirmationDialog } from "@repo/app/shared/components/delete-confirmation-dialog";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
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
import {
  getLatestContentForAttachmentWarnings,
  resolveActiveRoomId,
} from "./document-editor-scaffold-helpers";
import { VersionSelector } from "./version-selector";

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
   * Hide the "Move..." action / dialog (ISS-4382). Org-level subtypes (DOC)
   * cannot live in a project — the create validator rejects a `projectId` for
   * them — so exposing Move would let the editor persist a forbidden
   * project-plus-DOC state that then vanishes from the org Documents index.
   */
  hideMoveAction?: boolean;

  /** Render-prop slots */
  renderHeader: (ctx: ScaffoldSlotContext) => ReactNode;
  detailsSections: (ctx: ScaffoldSlotContext) => ReactNode;
  /** Optional chat tab inside FeedSidebar when feed flag is on */
  renderChatTab?: (ctx: ScaffoldSlotContext) => ReactNode;
  /**
   * Optional legacy right-rail chat panel, rendered inside the scaffold's
   * ResizablePanelGroup when the feed flag is off but chat is on. The panel is
   * an app-only surface (it reaches into the `apps/app` chat stack), so it is
   * injected as a render-prop rather than imported here — keeping this shared
   * scaffold free of app-local coupling. Adapters gate visibility off the same
   * `chatEnabled`/`feedEnabled` context they receive.
   */
  renderChatPanel?: (ctx: ScaffoldSlotContext) => ReactNode;
  /** Type-specific floating modals/pickers */
  floatingChildren?: (ctx: ScaffoldSlotContext) => ReactNode;
  /**
   * Optional stand-in for the editor body while the artifact's latest version
   * has nothing to read.
   *
   * The scaffold decides WHEN it may appear (latest version, empty body, not
   * being edited, not viewing history); the caller decides WHETHER it has
   * anything to say by returning null. That split keeps this shared scaffold
   * free of app-local coupling, the same way `renderChatPanel` is injected
   * rather than imported.
   *
   * The editor is HIDDEN, not unmounted, while this shows: unmounting would
   * drop the Liveblocks room and the content controller mid-run, and the
   * moment content lands the editor has to be there already.
   */
  renderEmptyContent?: (ctx: ScaffoldSlotContext) => ReactNode;
};

export function DocumentEditorScaffold({
  document,
  currentVersion,
  onVersionChange,
  buildPermalinkUrl,
  extraPending = false,
  redirectPath,
  resizableAutoSaveId,
  feedArtifactType,
  hideRepositoriesInMetadataBar = false,
  deleteDialogTitle,
  moveDialogTeamId,
  startInEditModeWhenEmpty = false,
  emptyContentPlaceholder = "Add description...",
  hideMoveAction = false,
  renderHeader,
  detailsSections,
  renderChatTab,
  renderChatPanel,
  floatingChildren,
  renderEmptyContent,
}: Readonly<DocumentEditorScaffoldProps>) {
  // Gate the Liveblocks room connection on the user/org context being ready
  // (FEA-2404). The parent CollaborationProviderWrapper mounts a *minimal*
  // LiveblocksProvider while `/me` is still loading; if a document's room
  // connects during that window, its auth callback fires before Clerk/org has
  // hydrated and can exhaust Liveblocks' hardcoded 10s auth timeout, surfacing
  // as a real-prod "Authentication failed: Timed out during auth" RUM error.
  // Deferring the room until `currentUser` resolves means the room connects
  // exactly once, under the full provider, with context ready. `useCurrentUser`
  // is already fetched by the wrapper, so TanStack Query dedupes this call.
  const { data: currentUser, isLoading: isUserLoading } = useCurrentUser();
  const searchParams = useSearchParamsValue();
  const commentThreadId = searchParams?.get("thread") ?? undefined;
  const chatEnabled = useFeatureFlagEnabled("interactive-chat");
  const feedEnabled = useFeatureFlagEnabled("comments-v2-feed-sidebar");

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
      acknowledgedVersionRef.current = Math.max(
        acknowledgedVersionRef.current,
        updated.version.version
      );
      onVersionChange(updated.version.version);
    },
  });
  const metadata = useDocumentMetadata({ artifact: document });

  const actions = useDocumentActions({ artifact: document, redirectPath });
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

  // Gated here rather than at the call site so every editor gets the same rule:
  // only the latest version, only a genuinely empty body, never while editing
  // or reading history. The caller still returns null when it has nothing to
  // show, so a quiet artifact falls straight through to the editor.
  const emptyContentStandIn =
    isLatestVersion &&
    isContentEmpty &&
    !(editMode.isEditing || session.isViewingHistorical)
      ? renderEmptyContent?.(ctx)
      : null;

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
              roomId={activeRoomId}
            >
              {activeRoomId ? (
                <DocumentRoomEventListener
                  documentId={document.id}
                  onRemoteVersionPublished={handleRemoteVersionPublished}
                />
              ) : null}
              <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
                {emptyContentStandIn}
                <div
                  className={editorLoaderClassName(
                    session.isEditorReady,
                    Boolean(emptyContentStandIn)
                  )}
                >
                  <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>

                <div
                  className={editorBodyClassName(
                    session.isEditorReady,
                    Boolean(emptyContentStandIn)
                  )}
                >
                  <InlineEditEditorShell
                    expanded={editMode.isEditing || session.isViewingHistorical}
                    toolbar={
                      <EditorToolbarRow
                        leftContent={
                          <RichTextToolbar
                            className="border-0 bg-transparent p-0"
                            editor={session.editor}
                            hasLiveblocksExtension={editorUsesLiveblocksContent}
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
                      editorUsesLiveblocksContent={editorUsesLiveblocksContent}
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
                      hideLeadingTitleHeading={hideLeadingTitleHeading}
                      key={currentVersion}
                      liveblocksRoomId={activeRoomId}
                      onBodyClick={editMode.enterEditMode}
                      onChange={contentController.updateContent}
                      onContentReady={session.handleEditorReady}
                      onEditorInstance={session.handleEditorInstance}
                      onOpenThreadCountChange={session.handleThreadCountChange}
                      placeholder={emptyContentPlaceholder}
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
                  documentId={document.id}
                  enabled={feedEnabled && !!activeRoomId}
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

        {!feedEnabled && chatEnabled ? renderChatPanel?.(ctx) : null}
      </ResizablePanelGroup>

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

      {floatingChildren ? floatingChildren(ctx) : null}
    </>
  );
}

/**
 * The loading spinner shows only while the editor is still coming up AND
 * nothing has taken the content region -- a stand-in already explains the wait,
 * so a second spinner underneath it is noise.
 */
export function editorLoaderClassName(
  isEditorReady: boolean,
  hasStandIn: boolean
): string {
  if (hasStandIn || isEditorReady) {
    return "hidden";
  }
  return "flex flex-1 items-center justify-center py-24";
}

/**
 * The editor is hidden rather than unmounted behind a stand-in, so the
 * Liveblocks room and content controller survive the run and the editor is
 * already mounted the moment content lands.
 */
export function editorBodyClassName(
  isEditorReady: boolean,
  hasStandIn: boolean
): string | undefined {
  if (hasStandIn || !isEditorReady) {
    return "invisible h-0 overflow-hidden";
  }
  return undefined;
}
