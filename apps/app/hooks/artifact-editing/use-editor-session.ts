"use client";

import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import { generateArtifactRoomId } from "@repo/collaboration/room-utils";
import type { Editor, JSONContent } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { mergeCommentMarks } from "@/components/artifact-editor/merge-comment-marks";

type UseEditorSessionConfig = {
  artifact: ArtifactDetail;
  currentVersion: number;
  latestVersion: number;
  content: {
    saveContent: () => void;
    discardChanges: () => void;
  };
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
  const { artifact, currentVersion, latestVersion, content } = config;

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
  const handleEditorInstance = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
  }, []);

  const isViewingHistorical = currentVersion !== latestVersion;

  // Always connect Liveblocks for the latest version so the editor is pre-loaded
  // and ready when the user clicks to edit. Only skip for historical versions
  // where content comes from the version prop, not Liveblocks.
  const liveblocksRoomId =
    !isViewingHistorical && artifact.slug
      ? generateArtifactRoomId(artifact.organizationId, artifact.slug)
      : null;

  // Detect server-side version changes (e.g. loop completion creating a new
  // artifact version) and force the editor to pick up the new content.
  // When Liveblocks is active the editor ignores the `value` prop, so the
  // only way to push new content in is via the contentReset mechanism.
  const prevVersionRef = useRef(currentVersion);
  useEffect(() => {
    if (currentVersion !== prevVersionRef.current) {
      prevVersionRef.current = currentVersion;
      if (!isViewingHistorical) {
        setContentResetValue(artifact.version.content ?? "");
        setContentResetKey((key) => (key ?? 0) + 1);
      }
    }
  }, [currentVersion, isViewingHistorical, artifact.version.content]);

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

  const handlePublish = useCallback(() => {
    content.saveContent();
    exitEditMode();
  }, [content, exitEditMode]);

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
    content.discardChanges();
    editorSnapshotRef.current = null;
    setIsEditing(false);
  }, [artifact.version.content, content]);

  return {
    // Editing state
    isEditing,
    isViewingHistorical,
    liveblocksRoomId,
    openThreadCount,

    // Content reset (for CollaborativeEditor)
    contentResetKey,
    contentResetValue,

    // Editor instance management
    handleEditorInstance,

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
