"use client";

import { DOC_SYNC_EDITOR_FLAG_KEY } from "@repo/api/src/types/doc-sync-editor-flag";
import type { DocumentDetail } from "@repo/api/src/types/document";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useCallback, useEffect, useState } from "react";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";
import { useCreateDocumentVersion } from "./use-documents";
import { useResetLiveDraft } from "./use-reset-live-draft";

type UseArtifactContentConfig = {
  artifact: DocumentDetail;
  isLatestVersion: boolean;
  setEditorContent: (content: string) => void;
  onVersionCreated?: (updatedArtifact: DocumentDetail) => void;
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
 *   useDocumentContent({ artifact, onVersionCreated: () => console.log('Saved!') });
 *
 * <RichTextEditor value={content} onChange={updateContent} />
 * <Button onClick={saveContent} disabled={!hasUnsavedChanges || isSaving}>Save</Button>
 * ```
 *
 * **Important:** Content updates are local until `saveContent()` is called, which creates a new version.
 */
export function useDocumentContent(config: UseArtifactContentConfig) {
  const { artifact, isLatestVersion, setEditorContent, onVersionCreated } =
    config;

  // TanStack Query mutation for creating new versions
  const createVersion = useCreateDocumentVersion(artifact.id);
  const resetLiveDraft = useResetLiveDraft(artifact.id);
  // The scaffold mounts `DocSyncRoom` from this flag; this hook runs above
  // that provider, so it reads the flag rather than the room (PLN-2190 T-3.1).
  const isOnDocSync = useFeatureFlagEnabled(DOC_SYNC_EDITOR_FLAG_KEY);

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
    (newContent?: string, resetRoom = false, onSuccess?: () => void) => {
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
            // On Liveblocks, `resetDocumentRoom` clears the room server-side,
            // so the publisher's editor reseeds it or renders blank until
            // another sync catches up. On doc-sync the server seeded the
            // version, which arrived as a Yjs sync before this response.
            if (!isOnDocSync) {
              setEditorContent(updatedArtifact.version.content ?? "");
            }
            onVersionCreated?.(updatedArtifact);
            onSuccess?.();
          },
        }
      );
    },
    [
      content,
      createVersion,
      hasUnsavedChanges,
      isOnDocSync,
      onVersionCreated,
      setEditorContent,
    ]
  );

  const restoreVersion = useCallback(() => {
    const versionContent = artifact.version.content ?? "";
    // A historical version is published as a new version; the server puts it
    // into the live document on both transports.
    if (!isLatestVersion) {
      if (!isOnDocSync) {
        setEditorContent(versionContent);
      }
      saveContent(versionContent, true);
      return;
    }
    if (isOnDocSync) {
      resetLiveDraft.mutate();
    } else {
      setEditorContent(versionContent);
    }
  }, [
    artifact.version.content,
    isLatestVersion,
    isOnDocSync,
    resetLiveDraft,
    saveContent,
    setEditorContent,
  ]);

  return {
    // Content state
    content,
    updateContent: setContent,
    hasUnsavedChanges,

    // Save operations
    saveContent,
    restoreVersion,
    isSaving,
  };
}
