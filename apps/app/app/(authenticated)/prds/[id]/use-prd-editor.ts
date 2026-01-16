"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  deleteArtifact,
  duplicateArtifact,
  renameArtifact,
  updateArtifact,
} from "@/app/actions/artifacts";
import {
  copyToClipboard,
  downloadAsMarkdown,
} from "@/lib/clipboard-and-download-utils";

export function usePRDEditor(prd: ArtifactWithWorkstream) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Content state
  const [content, setContent] = useState(prd.content ?? "");
  const [lastSaved, setLastSaved] = useState<Date>(prd.updatedAt);
  const [isSaving, setIsSaving] = useState(false);

  // Metadata state
  const [status, setStatus] = useState(prd.status);
  const [approver, setApprover] = useState(prd.approver ?? "");

  // UI state
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showGeneratePlanModal, setShowGeneratePlanModal] = useState(false);

  // Handlers
  const handleSave = useCallback(() => {
    setIsSaving(true);
    startTransition(async () => {
      const result = await updateArtifact({ id: prd.id, content });
      if (result.success) {
        setLastSaved(new Date());
        toast.success("Changes saved");
      } else {
        toast.error("Failed to save changes");
      }
      setIsSaving(false);
    });
  }, [prd.id, content]);

  const handleMetadataUpdate = useCallback(
    (
      updates: Partial<{
        status: ArtifactStatus;
        approver: string;
      }>
    ) => {
      startTransition(async () => {
        const result = await updateArtifact({ id: prd.id, ...updates });
        if (result.success) {
          setLastSaved(new Date());
          toast.success("Changes saved");
        } else {
          toast.error("Failed to save changes");
        }
      });
    },
    [prd.id]
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
    if (approver !== (prd.approver ?? "")) {
      handleMetadataUpdate({ approver: approver || undefined });
    }
  }, [approver, prd.approver, handleMetadataUpdate]);

  const handleRename = useCallback(
    (title: string, fileName: string) => {
      startTransition(async () => {
        await renameArtifact(prd.id, title, fileName);
        setShowRenameDialog(false);
      });
    },
    [prd.id]
  );

  const handleDuplicate = useCallback(() => {
    startTransition(async () => {
      const result = await duplicateArtifact(prd.id);
      if (result.success) {
        router.push(`/prds/${result.data.id}`);
      }
    });
  }, [prd.id, router]);

  const handleExport = useCallback(() => {
    downloadAsMarkdown(content, prd.fileName ?? `${prd.title}.md`);
  }, [content, prd.fileName, prd.title]);

  const handleCopyMarkdown = useCallback(async () => {
    const success = await copyToClipboard(content);
    if (success) {
      toast.success("Copied to clipboard");
    } else {
      toast.error("Failed to copy to clipboard");
    }
  }, [content]);

  const handleDelete = useCallback(() => {
    startTransition(async () => {
      await deleteArtifact(prd.id);
      router.push("/prds");
    });
  }, [prd.id, router]);

  return {
    // State
    isPending,
    content,
    setContent,
    lastSaved,
    isSaving,
    status,
    approver,
    showMetadataPanel,
    setShowMetadataPanel,
    showRenameDialog,
    setShowRenameDialog,
    showDeleteDialog,
    setShowDeleteDialog,
    showGeneratePlanModal,
    setShowGeneratePlanModal,

    // Handlers
    handleSave,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handleRename,
    handleDuplicate,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
  };
}
