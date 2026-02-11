"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useState } from "react";
import { useCreateNewVersion } from "@/hooks/queries/use-artifacts";

type UseArtifactContentConfig = {
  artifact: ArtifactWithWorkstream;
  onVersionCreated?: () => void;
};

/**
 * Hook to manage artifact content editing, version creation, and content state.
 *
 * **Use this hook when:** Your component needs to edit artifact content (markdown editor, text area).
 *
 * **What it provides:**
 * - Content state management with local editing
 * - Version creation when content is saved (preserves version history)
 * - Last saved timestamp tracking
 * - Loading states for save operations
 * - Unsaved changes detection
 *
 * **Example usage:**
 * ```tsx
 * const { content, updateContent, saveContent, hasUnsavedChanges, isSaving } =
 *   useArtifactContent({ artifact, onVersionCreated: () => console.log('Saved!') });
 *
 * <RichTextEditor value={content} onChange={updateContent} />
 * <Button onClick={saveContent} disabled={!hasUnsavedChanges || isSaving}>Save</Button>
 * ```
 *
 * **Important:** Content updates are local until `saveContent()` is called, which creates a new version.
 */
export function useArtifactContent(config: UseArtifactContentConfig) {
  const { artifact, onVersionCreated } = config;

  // TanStack Query mutation for creating new versions
  const createNewVersion = useCreateNewVersion();

  // Content state - tracks local edits
  const [content, setContent] = useState(artifact.content ?? "");
  const [lastSaved, setLastSaved] = useState<Date>(artifact.updatedAt);

  // Derived state
  const isSaving = createNewVersion.isPending;
  const hasUnsavedChanges = content !== (artifact.content ?? "");

  // Sync content state when artifact prop changes (e.g., after version creation, navigation)
  useEffect(() => {
    setContent(artifact.content ?? "");
    setLastSaved(artifact.updatedAt);
  }, [artifact.content, artifact.updatedAt]);

  /**
   * Save current content by creating a new version.
   * This preserves version history while updating the artifact.
   */
  const saveContent = useCallback(() => {
    if (!hasUnsavedChanges) {
      toast.info("No changes to save");
      return;
    }

    createNewVersion.mutate(
      { id: artifact.id, content },
      {
        onSuccess: () => {
          toast.success("New version created");
          onVersionCreated?.();
        },
      }
    );
  }, [
    artifact.id,
    content,
    createNewVersion,
    hasUnsavedChanges,
    onVersionCreated,
  ]);

  /**
   * Auto-save content silently (no toasts). Used by blur-to-save behavior.
   * Guards against double-saves by checking mutation pending state.
   */
  const autoSaveContent = useCallback(() => {
    if (!hasUnsavedChanges || createNewVersion.isPending) {
      return;
    }
    createNewVersion.mutate(
      { id: artifact.id, content },
      { onSuccess: () => onVersionCreated?.() }
    );
  }, [
    artifact.id,
    content,
    createNewVersion,
    hasUnsavedChanges,
    onVersionCreated,
  ]);

  /**
   * Discard local changes and revert to the last saved content.
   */
  const discardChanges = useCallback(() => {
    setContent(artifact.content ?? "");
    toast.info("Changes discarded");
  }, [artifact.content]);

  return {
    // Content state
    content,
    updateContent: setContent, // setContent is stable, no useCallback needed
    hasUnsavedChanges,

    // Save operations
    saveContent,
    autoSaveContent,
    discardChanges,
    isSaving,
    lastSaved,
  };
}
