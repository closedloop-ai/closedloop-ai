"use client";

import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useState } from "react";
import { useCreateArtifactVersion } from "@/hooks/queries/use-artifacts";

type UseArtifactContentConfig = {
  artifact: ArtifactDetail;
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
  const createVersion = useCreateArtifactVersion(artifact.id);

  // Content state - tracks local edits
  const [content, setContent] = useState(artifact.version.content ?? "");
  const [lastSaved, setLastSaved] = useState<Date>(artifact.updatedAt);

  // Derived state
  const isSaving = createVersion.isPending;
  const hasUnsavedChanges = content !== (artifact.version.content ?? "");

  // Sync content state when the version object changes (after version creation, version navigation).
  // biome-ignore lint/correctness/useExhaustiveDependencies: version.id detects version switches even when two versions share identical content
  useEffect(() => {
    setContent(artifact.version.content ?? "");
    setLastSaved(artifact.updatedAt);
  }, [artifact.version.content, artifact.version.id, artifact.updatedAt]);

  /**
   * Save current content by creating a new version.
   * This preserves version history while updating the artifact.
   */
  const saveContent = useCallback(() => {
    if (!hasUnsavedChanges) {
      toast.info("No changes to save");
      return;
    }

    createVersion.mutate(content, {
      onSuccess: () => {
        toast.success("New version created");
        onVersionCreated?.();
      },
    });
  }, [content, createVersion, hasUnsavedChanges, onVersionCreated]);

  /**
   * Discard local changes and revert to the last saved content.
   */
  const discardChanges = useCallback(() => {
    setContent(artifact.version.content ?? "");
    toast.info("Changes discarded");
  }, [artifact.version.content]);

  return {
    // Content state
    content,
    updateContent: setContent, // setContent is stable, no useCallback needed
    hasUnsavedChanges,

    // Save operations
    saveContent,
    discardChanges,
    isSaving,
    lastSaved,
  };
}
