"use client";

import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import type { TiptapEditor } from "@repo/rich-text";
import { useCallback, useEffect, useRef, useState } from "react";

type UseEditorSessionConfig = {
  artifact: ArtifactDetail;
  currentVersion: number;
  onVersionChange: (version: number) => void;
};

/**
 * Hook to manage the view/edit session lifecycle for collaborative artifact editors.
 *
 * Extracts the shared logic between PRD and Plan editors:
 * - Edit mode state (view by default, click to edit)
 * - Editor JSON snapshot for discard (preserving Liveblocks comment marks)
 * - Liveblocks room ID computation
 * - Content reset via augmented editor reference
 * - Thread count tracking
 *
 * @example
 * ```tsx
 * const session = useEditorSession({ artifact, currentVersion, latestVersion, content });
 *
 * <CollaborativeEditor
 *   readOnly={!session.isEditing}
 *   liveblocksRoomId={session.liveblocksRoomId}
 *   onEditorInstance={session.handleEditorInstance}
 * />
 * ```
 */
export function useEditorSession(config: UseEditorSessionConfig) {
  const { artifact, currentVersion, onVersionChange } = config;

  const [openThreadCount, setOpenThreadCount] = useState(0);
  const [isEditorReady, setIsEditorReady] = useState(false);
  const editorRef = useRef<TiptapEditor | null>(null);

  const isViewingHistorical = currentVersion !== artifact.latestVersion;

  // Always connect Liveblocks for the latest version so the editor is pre-loaded
  // and ready when the user clicks to edit. Only skip for historical versions
  // where content comes from the version prop, not Liveblocks.
  const liveblocksRoomId =
    !isViewingHistorical && artifact.slug
      ? generateArtifactRoomId(artifact.organizationId, artifact.slug)
      : null;

  const handleEditorInstance = useCallback(
    (editor: TiptapEditor | null) => {
      editorRef.current = editor;

      if (editor !== null && !liveblocksRoomId) {
        // For non-Liveblocks (historical versions), content is set synchronously
        // from the value prop, so the editor is content-ready on creation.
        setIsEditorReady(true);
      }
    },
    [liveblocksRoomId]
  );
  const handleEditorReady = useCallback(() => {
    setIsEditorReady(true);
  }, []);

  const setEditorContent = useCallback((content: string) => {
    editorRef.current?.resetContent(content);
  }, []);

  const handleGenerationComplete = useCallback((newContent: string) => {
    editorRef.current?.resetContent(newContent);
  }, []);

  // Reset editor content when server-side generation produces a new version.
  // The Liveblocks room is reset server-side, but active clients need a
  // resetContent call to overwrite the stale local Y.Doc.
  const prevLatestVersionRef = useRef(artifact.latestVersion);
  useEffect(() => {
    if (artifact.latestVersion > prevLatestVersionRef.current) {
      const wasViewingLatest = prevLatestVersionRef.current <= currentVersion;
      prevLatestVersionRef.current = artifact.latestVersion;

      // Navigate to the new version and reset editor content,
      // but only if the user was viewing the (now-old) latest version.
      // If they're browsing a historical version, leave them there.
      if (wasViewingLatest) {
        onVersionChange(artifact.latestVersion);
        handleGenerationComplete(artifact.version.content ?? "");
      }
    }
  }, [
    currentVersion,
    artifact.latestVersion,
    artifact.version.content,
    onVersionChange,
    handleGenerationComplete,
  ]);

  return {
    editor: editorRef.current,
    handleEditorInstance,
    isEditorReady,
    handleEditorReady,
    setEditorContent,
    isViewingHistorical,
    liveblocksRoomId,
    openThreadCount,
    handleThreadCountChange: setOpenThreadCount,
  };
}
