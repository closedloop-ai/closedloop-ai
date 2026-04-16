"use client";

import type { ArtifactDetail } from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import {
  useDeleteArtifact,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import { copyToClipboard } from "@/lib/clipboard-utils";
import { downloadAsMarkdown } from "@/lib/download-utils";

type UseArtifactActionsConfig = {
  artifact: ArtifactDetail;
  redirectPath: string;
};

/**
 * Hook to manage artifact actions: delete, rename, download, and copy.
 *
 * **Use this hook when:** Your component needs to perform artifact operations (toolbar buttons, action menus).
 *
 * **What it provides:**
 * - Delete operation with automatic navigation after success
 * - Rename operation (updates title and fileName)
 * - Download operation (exports content as markdown file)
 * - Copy operation (copies content to clipboard)
 * - Loading states for each operation
 *
 * **Example usage:**
 * ```tsx
 * const { handleDelete, handleRename, handleDownload, handleCopy, isDeleting } =
 *   useArtifactActions({ artifact, redirectPath: "/prds" });
 *
 * <Button onClick={handleDownload}>Download</Button>
 * <Button onClick={handleCopy}>Copy</Button>
 * <Button onClick={handleDelete} disabled={isDeleting}>Delete</Button>
 * ```
 *
 * **Important:** Delete operation automatically redirects to `redirectPath` on success.
 */
export function useArtifactActions(config: UseArtifactActionsConfig) {
  const { artifact, redirectPath } = config;
  const router = useRouter();

  // TanStack Query mutations
  const deleteArtifact = useDeleteArtifact();
  const updateArtifact = useUpdateArtifact();

  // Derived state
  const isDeleting = deleteArtifact.isPending;
  const isRenaming = updateArtifact.isPending;

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
            router.push(redirectPath);
            resolve(true);
          },
          onError: () => {
            resolve(false);
          },
        });
      }),
    [artifact.id, deleteArtifact, redirectPath, router]
  );

  /**
   * Rename the artifact by updating its title and fileName.
   * Shows success toast on completion, error toast on failure.
   */
  const handleRename = useCallback(
    (title: string, fileName: string): Promise<boolean> =>
      new Promise((resolve) => {
        updateArtifact.mutate(
          { id: artifact.id, title, fileName },
          {
            onSuccess: () => {
              toast.success("Artifact renamed");
              resolve(true);
            },
            onError: () => {
              resolve(false);
            },
          }
        );
      }),
    [artifact.id, updateArtifact]
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
    handleRename,
    handleDownload,
    handleCopy,

    // Loading states
    isDeleting,
    isRenaming,
  };
}
