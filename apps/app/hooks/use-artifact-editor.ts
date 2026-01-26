"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  useArtifactGenerationStatus,
  useCreateNewVersion,
  useDeleteArtifact,
  useDuplicateArtifact,
  useRegenerateArtifact,
  useRequestPlanChanges,
  useUpdateArtifact,
} from "@/hooks/queries/use-artifacts";
import { copyToClipboard } from "@/lib/clipboard-utils";
import { downloadAsMarkdown } from "@/lib/download-utils";

type BaseConfig = {
  artifact: ArtifactWithWorkstream;
  redirectPath: string;
};

/**
 * Internal hook with all artifact editing logic.
 * Use usePRDEditorHook or usePlanEditorHook for typed returns.
 */
function useArtifactEditorInternal(config: BaseConfig) {
  const { artifact, redirectPath } = config;
  const router = useRouter();

  // TanStack Query mutations
  const createNewVersion = useCreateNewVersion();
  const updateArtifact = useUpdateArtifact();
  const deleteArtifact = useDeleteArtifact();
  const duplicateArtifact = useDuplicateArtifact();
  const regenerateArtifact = useRegenerateArtifact();
  const requestPlanChanges = useRequestPlanChanges();

  // Generation status (for plans)
  const { data: generationStatus } = useArtifactGenerationStatus(artifact.id);

  // Content state
  const [content, setContent] = useState(artifact.content ?? "");
  const [lastSaved, setLastSaved] = useState<Date>(artifact.updatedAt);

  // Metadata state
  const [status, setStatus] = useState(artifact.status);
  const [approver, setApprover] = useState(artifact.approver ?? "");
  const [targetRepo, setTargetRepo] = useState(artifact.targetRepo ?? "");
  const [targetBranch, setTargetBranch] = useState(
    artifact.targetBranch ?? "main"
  );

  // UI state - common
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // UI state - PRD specific
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showGeneratePlanModal, setShowGeneratePlanModal] = useState(false);

  // UI state - Plan specific
  const [showRequestChangesModal, setShowRequestChangesModal] = useState(false);
  const [showLinearExportDialog, setShowLinearExportDialog] = useState(false);

  // Derived state
  const isDraft = status === "DRAFT";
  const isSaving = createNewVersion.isPending;
  const isPending =
    updateArtifact.isPending ||
    deleteArtifact.isPending ||
    duplicateArtifact.isPending ||
    regenerateArtifact.isPending;

  // Sync state when artifact prop changes (e.g., server refresh, navigation)
  useEffect(() => {
    setContent(artifact.content ?? "");
    setLastSaved(artifact.updatedAt);
    setStatus(artifact.status);
    setApprover(artifact.approver ?? "");
    setTargetRepo(artifact.targetRepo ?? "");
    setTargetBranch(artifact.targetBranch ?? "main");
  }, [
    artifact.content,
    artifact.updatedAt,
    artifact.status,
    artifact.approver,
    artifact.targetRepo,
    artifact.targetBranch,
  ]);

  // ============================================
  // Content Handlers (creates new version)
  // ============================================

  const handleSaveContent = useCallback(() => {
    createNewVersion.mutate(
      { id: artifact.id, content },
      {
        onSuccess: (newArtifact) => {
          toast.success("New version created");
          // Navigate to the new version
          router.push(`${redirectPath}/${newArtifact.id}`);
        },
      }
    );
  }, [artifact.id, content, createNewVersion, redirectPath, router]);

  // ============================================
  // Metadata Handlers (updates current record)
  // ============================================

  const handleMetadataUpdate = useCallback(
    (
      updates: Partial<{
        status: ArtifactStatus;
        approver: string;
        targetRepo: string | null;
        targetBranch: string | null;
        title: string;
        fileName: string;
      }>
    ) => {
      updateArtifact.mutate(
        { id: artifact.id, ...updates },
        {
          onSuccess: () => {
            toast.success("Changes saved");
          },
        }
      );
    },
    [artifact.id, updateArtifact]
  );

  const handleStatusChange = useCallback(
    (newStatus: ArtifactStatus) => {
      setStatus(newStatus);
      handleMetadataUpdate({ status: newStatus });
    },
    [handleMetadataUpdate]
  );

  const handleApproverChange = useCallback((newApprover: string) => {
    setApprover(newApprover);
  }, []);

  const handleApproverBlur = useCallback(() => {
    if (approver !== (artifact.approver ?? "")) {
      handleMetadataUpdate({ approver: approver || undefined });
    }
  }, [approver, artifact.approver, handleMetadataUpdate]);

  const handleTargetRepoChange = useCallback((newTargetRepo: string) => {
    setTargetRepo(newTargetRepo);
  }, []);

  const handleTargetRepoBlur = useCallback(() => {
    if (targetRepo !== (artifact.targetRepo ?? "")) {
      handleMetadataUpdate({ targetRepo: targetRepo || null });
    }
  }, [targetRepo, artifact.targetRepo, handleMetadataUpdate]);

  const handleTargetBranchChange = useCallback((newTargetBranch: string) => {
    setTargetBranch(newTargetBranch);
  }, []);

  const handleTargetBranchBlur = useCallback(() => {
    if (targetBranch !== (artifact.targetBranch ?? "main")) {
      handleMetadataUpdate({ targetBranch: targetBranch || null });
    }
  }, [targetBranch, artifact.targetBranch, handleMetadataUpdate]);

  // ============================================
  // Action Handlers
  // ============================================

  const handleRename = useCallback(
    (title: string, fileName: string) => {
      handleMetadataUpdate({ title, fileName });
      setShowRenameDialog(false);
    },
    [handleMetadataUpdate]
  );

  const handleDuplicate = useCallback(() => {
    duplicateArtifact.mutate(artifact.id, {
      onSuccess: (newArtifact) => {
        router.push(`${redirectPath}/${newArtifact.id}`);
      },
    });
  }, [artifact.id, duplicateArtifact, redirectPath, router]);

  const handleDelete = useCallback(() => {
    deleteArtifact.mutate(artifact.id, {
      onSuccess: () => {
        router.push(redirectPath);
      },
      onError: () => {
        toast.error("Failed to delete");
      },
    });
  }, [artifact.id, deleteArtifact, redirectPath, router]);

  const handleDownloadMarkdown = useCallback(() => {
    downloadAsMarkdown(
      content,
      artifact.fileName ??
        `${artifact.title.toLowerCase().replaceAll(/\s+/g, "-")}.md`
    );
  }, [content, artifact.fileName, artifact.title]);

  const handleCopyMarkdown = useCallback(async () => {
    const success = await copyToClipboard(content);
    if (success) {
      toast.success("Copied to clipboard");
    } else {
      toast.error("Failed to copy to clipboard");
    }
  }, [content]);

  // ============================================
  // Plan-specific Handlers
  // ============================================

  const handleApprove = useCallback(() => {
    updateArtifact.mutate(
      { id: artifact.id, status: "APPROVED" },
      {
        onSuccess: () => {
          toast.success("Plan approved");
        },
      }
    );
  }, [artifact.id, updateArtifact]);

  const handleRegenerate = useCallback(() => {
    regenerateArtifact.mutate(artifact.id, {
      onSuccess: () => {
        toast.success("Plan generation started");
      },
    });
  }, [artifact.id, regenerateArtifact]);

  const handleRequestChanges = useCallback(
    (changes: string) => {
      requestPlanChanges.mutate(
        { artifactId: artifact.id, changes },
        {
          onSuccess: (result) => {
            setShowRequestChangesModal(false);
            toast.success(
              "Change request submitted - generating updated plan..."
            );
            router.push(`${redirectPath}/${result.artifactId}`);
          },
        }
      );
    },
    [artifact.id, requestPlanChanges, redirectPath, router]
  );

  return {
    // Common state
    isPending,
    content,
    setContent,
    lastSaved,
    isSaving,
    status,
    approver,
    showMetadataPanel,
    setShowMetadataPanel,
    showDeleteDialog,
    setShowDeleteDialog,

    // Common handlers
    handleSaveContent,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handleDownloadMarkdown,
    handleCopyMarkdown,
    handleDelete,

    // PRD-specific state
    targetRepo,
    targetBranch,
    showRenameDialog,
    setShowRenameDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,

    // PRD-specific handlers
    handleTargetRepoChange,
    handleTargetRepoBlur,
    handleTargetBranchChange,
    handleTargetBranchBlur,
    handleRename,
    handleDuplicate,
    handleExport: handleDownloadMarkdown,

    // Plan-specific state
    showRequestChangesModal,
    setShowRequestChangesModal,
    isRequestingChanges: requestPlanChanges.isPending,
    showLinearExportDialog,
    setShowLinearExportDialog,
    isDraft,
    generationStatus,

    // Plan-specific handlers
    handleApprove,
    handleRegenerate,
    handleRequestChanges,
  };
}

/**
 * Hook for PRD editor functionality.
 * Content saves create a new version; metadata updates modify in place.
 */
export function usePRDEditor(prd: ArtifactWithWorkstream) {
  return useArtifactEditorInternal({
    artifact: prd,
    redirectPath: "/prds",
  });
}

/**
 * Hook for Implementation Plan editor functionality.
 * Content saves create a new version; metadata updates modify in place.
 */
export function usePlanEditor(plan: ArtifactWithWorkstream) {
  return useArtifactEditorInternal({
    artifact: plan,
    redirectPath: "/implementation-plans",
  });
}
