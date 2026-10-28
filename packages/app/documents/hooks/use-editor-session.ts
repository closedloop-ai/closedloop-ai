"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import type { TiptapEditor } from "@repo/rich-text";
import { useCallback, useEffect, useRef, useState } from "react";

type UseEditorSessionConfig = {
  artifact: DocumentDetail;
  currentVersion: number;
};

/**
 * Hook to manage the view/edit session lifecycle for collaborative artifact editors.
 *
 * Extracts the shared logic between PRD and Plan editors:
 * - Edit mode state (view by default, click to edit)
 * - Editor JSON snapshot for discard (preserving Liveblocks comment marks)
 * - Liveblocks room ID computation
 * - Content reset via augmented editor reference
 *
 * @example
 * ```tsx
 * const session = useEditorSession({ artifact, currentVersion });
 *
 * <CollaborativeEditorBody
 *   readOnly={!session.isEditing}
 *   liveblocksRoomId={session.liveblocksRoomId}
 *   onEditorInstance={session.handleEditorInstance}
 * />
 * ```
 */
export function useEditorSession(config: UseEditorSessionConfig) {
  const { artifact, currentVersion } = config;

  const [isEditorReady, setIsEditorReady] = useState(false);
  const editorRef = useRef<TiptapEditor | null>(null);

  // On the Liveblocks path `isEditorReady` only flips after Y.Doc sync
  // completes, and nothing else ever flips it. A room that never syncs — auth
  // failure, room creation failure, a dead connection — used to leave the
  // caller's editor body hidden forever with no error and no way back
  // (ISS-7058). Time the wait out so a permanently-not-ready editor becomes a
  // stated failure instead of silence.
  const [hasEditorReadyTimedOut, setHasEditorReadyTimedOut] = useState(false);
  useEffect(() => {
    if (isEditorReady) {
      setHasEditorReadyTimedOut(false);
      return;
    }
    const timer = setTimeout(
      () => setHasEditorReadyTimedOut(true),
      EDITOR_READY_TIMEOUT_MS
    );
    return () => clearTimeout(timer);
  }, [isEditorReady]);

  // Readiness and its verdict belong to an editor SESSION, not to this hook.
  // The scaffold remounts the editor subtree on `key={currentVersion}` while the
  // containers switch versions without remounting the scaffold, so a version
  // switch starts a brand-new Y.Doc sync underneath state that had already
  // latched. The second and later versions inherited the first one's success —
  // the timeout above never armed and a failed resync went back to being silent
  // (ISS-7058 review, chatgpt-codex-connector) — and a verdict left over from a
  // version that did fail would condemn the next one before its window opened.
  //
  // Adjusted during render rather than in an effect because effects run
  // child-first: a reset effect here would fire AFTER the remounted editor had
  // already reported ready and would clear that report, timing out a healthy
  // editor. Resetting during render lands strictly before the new subtree can
  // signal, and it re-resets on every switch, so 2 -> 1 -> 2 cannot resurrect a
  // stale verdict either.
  const [readySessionVersion, setReadySessionVersion] =
    useState(currentVersion);
  if (readySessionVersion !== currentVersion) {
    setReadySessionVersion(currentVersion);
    setIsEditorReady(false);
    setHasEditorReadyTimedOut(false);
  }

  const isViewingHistorical = currentVersion !== artifact.latestVersion;

  // Always derive the room ID from the artifact slug — there is one room per
  // artifact regardless of which version is being viewed. The room is cheap to
  // mount; the more expensive question is whether the editor reads its content
  // from the Y.Doc (latest version) or from the static value prop (historical).
  const liveblocksRoomId = artifact.slug
    ? generateDocumentRoomId(artifact.organizationId, artifact.slug)
    : null;

  // Editor uses the Liveblocks Tiptap extension for content sync only on the
  // latest version. On historical views, content comes from the version prop.
  const editorUsesLiveblocksContent =
    !isViewingHistorical && !!liveblocksRoomId;

  const handleEditorInstance = useCallback(
    (editor: TiptapEditor | null) => {
      editorRef.current = editor;

      if (editor !== null && !editorUsesLiveblocksContent) {
        // When the editor isn't reading from Y.Doc, content is set synchronously
        // from the value prop, so the editor is content-ready on creation.
        setIsEditorReady(true);
      }
    },
    [editorUsesLiveblocksContent]
  );
  const handleEditorReady = useCallback(() => {
    setIsEditorReady(true);
  }, []);

  const setEditorContent = useCallback((content: string) => {
    editorRef.current?.resetContent(content);
  }, []);

  return {
    editor: editorRef.current,
    handleEditorInstance,
    isEditorReady,
    hasEditorReadyTimedOut,
    handleEditorReady,
    setEditorContent,
    isViewingHistorical,
    liveblocksRoomId,
    editorUsesLiveblocksContent,
  };
}

/**
 * How long the editor may stay not-ready before the surface states that it
 * failed. Generous on purpose: Liveblocks' own auth timeout is 10s, and a false
 * failure on a slow connection is the same lie in the other direction.
 */
export const EDITOR_READY_TIMEOUT_MS = 20_000;
