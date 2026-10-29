"use client";

import type { DocumentDetail } from "@repo/api/src/types/document";
import { copyToClipboard } from "@repo/app/shared/lib/clipboard-utils";
import { downloadAsMarkdown } from "@repo/app/shared/lib/download-utils";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useCallback } from "react";
import { useDeleteDocument } from "./use-documents";

type UseArtifactActionsConfig = {
  artifact: DocumentDetail;
  redirectPath: string;
};

/**
 * Hook to manage artifact actions: delete, download, and copy.
 *
 * **Use this hook when:** Your component needs to perform artifact operations (toolbar buttons, action menus).
 *
 * **What it provides:**
 * - Delete operation with automatic navigation after success
 * - Download operation (exports content as markdown file)
 * - Copy operation (copies content to clipboard)
 * - `isDeleting` while a delete is in flight
 *
 * **Example usage:**
 * ```tsx
 * const { handleDelete, handleDownload, handleCopy, isDeleting } =
 *   useDocumentActions({ artifact, redirectPath: "/prds" });
 *
 * <Button onClick={handleDownload}>Download</Button>
 * <Button onClick={handleCopy}>Copy</Button>
 * <Button onClick={handleDelete} disabled={isDeleting}>Delete</Button>
 * ```
 *
 * **Important:** Delete operation automatically redirects to `redirectPath` on success.
 */
export function useDocumentActions(config: UseArtifactActionsConfig) {
  const { artifact, redirectPath } = config;
  const navigation = useNavigation();

  // TanStack Query mutations
  const deleteArtifact = useDeleteDocument();

  // Derived state
  const isDeleting = deleteArtifact.isPending;

  /**
   * Delete the artifact and redirect to the specified path.
   * Returns a Promise<boolean> for callers that need to await the result
   * (e.g. DeleteConfirmationDialog).
   */
  const handleDelete = useCallback(
    (): Promise<boolean> =>
      new Promise((resolve) => {
        deleteArtifact.mutate(artifact.id, {
          onSuccess: () => {
            toast.success("Artifact deleted");
            navigation.navigate(redirectPath);
            resolve(true);
          },
          onError: () => {
            resolve(false);
          },
        });
      }),
    [artifact.id, deleteArtifact, redirectPath, navigation]
  );

  /**
   * Download the artifact content as a markdown file.
   * Uses the artifact's fileName if available, otherwise generates one from the title.
   */
  const handleDownload = useCallback(() => {
    const content = artifact.version.content ?? "";
    const fileName =
      artifact.fileName ??
      `${artifact.title.toLowerCase().replaceAll(/\s+/g, "-")}.md`;

    downloadAsMarkdown(content, fileName);
    toast.success("Downloaded as markdown");
  }, [artifact.version.content, artifact.fileName, artifact.title]);

  /**
   * Copy the artifact content to the clipboard.
   * Shows success or error toast based on the result.
   */
  const handleCopy = useCallback(async () => {
    const content = artifact.version.content ?? "";
    const success = await copyToClipboard(content);

    if (success) {
      toast.success("Copied to clipboard");
    } else {
      toast.error("Failed to copy to clipboard");
    }
  }, [artifact.version.content]);

  return {
    // Action handlers
    handleDelete,
    handleDownload,
    handleCopy,

    // Loading states
    isDeleting,
  };
}
