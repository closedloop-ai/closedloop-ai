"use client";

import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useState } from "react";
import { useCreateArtifactVersion } from "@/hooks/queries/use-artifacts";

type UseArtifactContentConfig = {
  artifact: ArtifactDetail;
  isLatestVersion: boolean;
  setEditorContent: (content: string) => void;
  onVersionCreated?: (updatedArtifact: ArtifactDetail) => void;
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
  const { artifact, isLatestVersion, setEditorContent, onVersionCreated } =
    config;

  // TanStack Query mutation for creating new versions
  const createVersion = useCreateArtifactVersion(artifact.id);

  // Content state - tracks local edits
  const [content, setContent] = useState(artifact.version.content ?? "");

  // Derived state
  const isSaving = createVersion.isPending;
  const hasUnsavedChanges = content !== artifact.version.content;

  // Sync content state when the version object changes (after version creation, version navigation).
  useEffect(
    function trackContentChanges() {
      setContent(artifact.version.content ?? "");
    },
    [artifact.version.content]
  );

  /**
   * Save current content by creating a new version.
   * This preserves version history while updating the artifact.
   */
  const saveContent = useCallback(
    (newContent?: string, resetRoom = false) => {
      if (newContent === undefined && !hasUnsavedChanges) {
        toast.info("No changes to publish");
        return;
      }

      createVersion.mutate(
        {
          content: newContent ?? content,
          resetRoom,
        },
        {
          onSuccess: (updatedArtifact) => {
            toast.success("New version published");
            onVersionCreated?.(updatedArtifact);
          },
        }
      );
    },
    [content, createVersion, onVersionCreated, hasUnsavedChanges]
  );

  const restoreVersion = useCallback(() => {
    setEditorContent(artifact.version.content ?? "");

    // If the user is on the latest version, just overwrite what's in liveblocks.
    // Otherwise we need to publish a new version with the content from the previous version.
    if (!isLatestVersion) {
      saveContent(artifact.version.content ?? "", true);
    }
  }, [
    artifact.version.content,
    setEditorContent,
    saveContent,
    isLatestVersion,
  ]);

  return {
    // Content state
    content,
    updateContent: setContent,

    // Save operations
    saveContent,
    restoreVersion,
    isSaving,
  };
}
