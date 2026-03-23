"use client";

import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import type { Editor, JSONContent } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeCommentMarks } from "@/components/artifact-editor/merge-comment-marks";

type UseEditorSessionConfig = {
  artifact: ArtifactDetail;
  currentVersion: number;
  contentCallbacks: {
    saveContent: () => void;
    discardChanges: () => void;
  };
  onVersionChange: (version: number) => void;
};

/**
 * Hook to manage the view/edit session lifecycle for collaborative artifact editors.
 *
 * Extracts the shared logic between PRD and Plan editors:
 * - Edit mode state (view by default, click to edit)
 * - Editor JSON snapshot for discard (preserving Liveblocks comment marks)
 * - Liveblocks room ID computation
 * - Content reset state for version restore
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
 *   contentResetKey={session.contentResetKey}
 *   contentResetValue={session.contentResetValue}
 * />
 * ```
 */
export function useEditorSession(config: UseEditorSessionConfig) {
  const { artifact, currentVersion, contentCallbacks, onVersionChange } =
    config;

  const [isEditing, setIsEditing] = useState(false);
  const [openThreadCount, setOpenThreadCount] = useState(0);
  const handleThreadCountChange = useCallback((count: number) => {
    setOpenThreadCount(count);
  }, []);
  const [contentResetKey, setContentResetKey] = useState<number | undefined>(
    undefined
  );
  const [contentResetValue, setContentResetValue] = useState<
    string | undefined
  >(undefined);

  const editorRef = useRef<Editor | null>(null);
  const editorSnapshotRef = useRef<JSONContent | null>(null);
  const [isEditorReady, setIsEditorReady] = useState(false);
  const [isContentReady, setIsContentReady] = useState(false);

  const isViewingHistorical = currentVersion !== artifact.latestVersion;

  // Always connect Liveblocks for the latest version so the editor is pre-loaded
  // and ready when the user clicks to edit. Only skip for historical versions
  // where content comes from the version prop, not Liveblocks.
  const liveblocksRoomId =
    !isViewingHistorical && artifact.slug
      ? generateArtifactRoomId(artifact.organizationId, artifact.slug)
      : null;

  const handleEditorInstance = useCallback(
    (editor: Editor | null) => {
      editorRef.current = editor;
      setIsEditorReady(editor !== null);
      if (editor === null) {
        // Editor unmounting (e.g. version change via key remount) — reset
        // content readiness so the loading spinner reappears.
        setIsContentReady(false);
      } else if (!liveblocksRoomId) {
        // For non-Liveblocks (historical versions), content is set synchronously
        // from the value prop, so the editor is content-ready on creation.
        setIsContentReady(true);
      }
    },
    [liveblocksRoomId]
  );
  const handleContentReady = useCallback(() => {
    setIsContentReady(true);
  }, []);

  const exitEditMode = useCallback(() => {
    setIsEditing(false);
    setContentResetKey(undefined);
    setContentResetValue(undefined);
  }, []);

  const handleEdit = useCallback(() => {
    if (!isViewingHistorical) {
      editorSnapshotRef.current = editorRef.current?.getJSON() ?? null;
      setIsEditing(true);
    }
  }, [isViewingHistorical]);

  const handleRestoreVersion = useCallback(() => {
    setContentResetValue(artifact.version.content ?? "");
    setContentResetKey((key) => (key ?? 0) + 1);
    setIsEditing(true);
  }, [artifact.version.content]);

  const handleGenerationComplete = useCallback((newContent: string) => {
    setContentResetValue(newContent);
    setContentResetKey((key) => (key ?? 0) + 1);
    setIsEditing(false);
  }, []);

  // Reset editor content when server-side generation produces a new version.
  // The Liveblocks room is reset server-side, but active clients need a
  // contentResetKey bump to overwrite the stale local Y.Doc.
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

  const handlePublish = useCallback(() => {
    contentCallbacks.saveContent();
    exitEditMode();
  }, [contentCallbacks, exitEditMode]);

  const handleDiscard = useCallback(() => {
    const snapshot = editorSnapshotRef.current;
    if (snapshot && editorRef.current) {
      // Merge current comment marks into the snapshot so thread anchoring
      // survives the content revert (comments on unchanged text persist).
      const editor = editorRef.current;
      const currentJson = editor.getJSON();
      const merged = mergeCommentMarks(snapshot, currentJson);
      // Must temporarily make editor editable since setIsEditing(false)
      // will set readOnly before the microtask runs.
      queueMicrotask(() => {
        const wasEditable = editor.isEditable;
        if (!wasEditable) {
          editor.setEditable(true);
        }
        editor.commands.setContent(merged);
        if (!wasEditable) {
          editor.setEditable(false);
        }
      });
    } else {
      // Fallback: reset via markdown (strips thread marks)
      setContentResetValue(artifact.version.content ?? "");
      setContentResetKey((key) => (key ?? 0) + 1);
    }
    contentCallbacks.discardChanges();
    editorSnapshotRef.current = null;
    setIsEditing(false);
  }, [artifact.version.content, contentCallbacks]);

  return {
    // Editing state
    isEditing,
    isEditorReady,
    isContentReady,
    isViewingHistorical,
    liveblocksRoomId,
    openThreadCount,

    // Content reset (for CollaborativeEditor)
    contentResetKey,
    contentResetValue,

    // Editor instance management
    handleEditorInstance,
    handleContentReady,

    // Thread count
    handleThreadCountChange,

    // Actions
    handleEdit,
    handleRestoreVersion,
    handlePublish,
    handleDiscard,
    exitEditMode,
  };
}
