"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { deleteArtifact, updateArtifact } from "@/app/actions/artifacts";
import { copyToClipboard } from "@/lib/clipboard-utils";
import { downloadAsMarkdown } from "@/lib/download-utils";

export function usePlanEditor(plan: ArtifactWithWorkstream) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Content state
  const [content, setContent] = useState(plan.content ?? "");
  const [lastSaved, setLastSaved] = useState<Date>(plan.updatedAt);
  const [isSaving, setIsSaving] = useState(false);

  // Metadata state
  const [status, setStatus] = useState(plan.status);
  const [approver, setApprover] = useState(plan.approver ?? "");

  // UI state
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Sync state when plan prop changes (e.g., server refresh, navigation)
  useEffect(() => {
    setContent(plan.content ?? "");
    setLastSaved(plan.updatedAt);
    setStatus(plan.status);
    setApprover(plan.approver ?? "");
  }, [plan.content, plan.updatedAt, plan.status, plan.approver]);

  const isDraft = status === "DRAFT";

  // Handlers
  const handleSave = useCallback(() => {
    setIsSaving(true);
    startTransition(async () => {
      const result = await updateArtifact({ id: plan.id, content });
      if (result.success) {
        setLastSaved(new Date());
        toast.success("Changes saved");
      } else {
        toast.error("Failed to save changes");
      }
      setIsSaving(false);
    });
  }, [plan.id, content]);

  const handleMetadataUpdate = useCallback(
    (
      updates: Partial<{
        status: ArtifactStatus;
        approver: string;
      }>
    ) => {
      startTransition(async () => {
        const result = await updateArtifact({ id: plan.id, ...updates });
        if (result.success) {
          setLastSaved(new Date());
          toast.success("Changes saved");
        } else {
          toast.error("Failed to save changes");
        }
      });
    },
    [plan.id]
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
    if (approver !== (plan.approver ?? "")) {
      handleMetadataUpdate({ approver: approver || undefined });
    }
  }, [approver, plan.approver, handleMetadataUpdate]);

  const handleApprove = useCallback(() => {
    startTransition(async () => {
      const result = await updateArtifact({
        id: plan.id,
        status: "APPROVED",
      });
      if (result.success) {
        setStatus("APPROVED");
        setLastSaved(new Date());
        toast.success("Plan approved");
      } else {
        toast.error("Failed to approve plan");
      }
    });
  }, [plan.id]);

  const handleExport = useCallback(() => {
    downloadAsMarkdown(
      content,
      plan.fileName ?? `${plan.title.toLowerCase().replace(/\s+/g, "-")}.md`
    );
  }, [content, plan.fileName, plan.title]);

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
      await deleteArtifact(plan.id);
      router.push("/implementation-plans");
    });
  }, [plan.id, router]);

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
    showDeleteDialog,
    setShowDeleteDialog,
    isDraft,

    // Handlers
    handleSave,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handleApprove,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
  };
}
