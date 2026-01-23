"use client";

import type {
  ArtifactStatus,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
  createNewVersion,
  deleteArtifact,
  type GenerationStatus,
  getArtifactById,
  getGenerationStatus,
  regenerateArtifact,
  requestPlanChanges,
  updateArtifact,
} from "@/app/actions/artifacts";
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
  const [showRequestChangesModal, setShowRequestChangesModal] = useState(false);
  const [isRequestingChanges, setIsRequestingChanges] = useState(false);

  // Editor refresh key - increment to force MDXEditor remount
  const [editorKey, setEditorKey] = useState(0);

  // Generation status (for showing GitHub action link in Details panel)
  const [generationStatus, setGenerationStatus] =
    useState<GenerationStatus | null>(null);

  // Sync state when plan prop changes (e.g., server refresh, navigation)
  useEffect(() => {
    setContent(plan.content ?? "");
    setLastSaved(plan.updatedAt);
    setStatus(plan.status);
    setApprover(plan.approver ?? "");
  }, [plan.content, plan.updatedAt, plan.status, plan.approver]);

  // Fetch generation status on mount and when plan changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: plan.updatedAt intentionally triggers re-fetch after generation completes
  useEffect(() => {
    getGenerationStatus(plan.id).then((result) => {
      if (result.success) {
        setGenerationStatus(result.data);
      }
    });
  }, [plan.id, plan.updatedAt]);

  const isDraft = status === "DRAFT";

  // Handlers
  const handleSave = useCallback(() => {
    setIsSaving(true);
    startTransition(async () => {
      // If viewing an old version, create a new version (preserves v5, v6, v7 etc.)
      if (!plan.isLatest) {
        const result = await createNewVersion({ id: plan.id, content });
        if (result.success) {
          toast.success(`Saved as v${result.data.version}`);
          router.push(`/implementation-plans/${result.data.id}`);
        } else {
          toast.error("Failed to save");
        }
        setIsSaving(false);
        return;
      }

      // Latest version: update in place (auto-increments version)
      const result = await updateArtifact({ id: plan.id, content });
      if (result.success) {
        setLastSaved(new Date());
        toast.success("Changes saved");
      } else {
        toast.error("Failed to save changes");
      }
      setIsSaving(false);
    });
  }, [plan.id, plan.isLatest, content, router]);

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

  const handleRegenerate = useCallback(() => {
    startTransition(async () => {
      const result = await regenerateArtifact(plan.id);
      if (result.success) {
        setContent(result.data.content ?? "");
        setLastSaved(new Date());
        toast.success("Plan regeneration started");
      } else {
        toast.error(result.error || "Failed to regenerate plan");
      }
    });
  }, [plan.id]);

  const handleRequestChanges = useCallback(
    async (changes: string) => {
      setIsRequestingChanges(true);
      try {
        const result = await requestPlanChanges(plan.id, changes);
        if (result.success) {
          setShowRequestChangesModal(false);
          toast.success(
            "Change request submitted - generating updated plan..."
          );
          // Navigate to the new artifact version
          router.push(`/implementation-plans/${result.data.artifactId}`);
        } else {
          // Ensure error is a string
          const errorMessage =
            typeof result.error === "string"
              ? result.error
              : (result.error as { message?: string })?.message ||
                "Failed to submit change request";
          throw new Error(errorMessage);
        }
      } finally {
        setIsRequestingChanges(false);
      }
    },
    [plan.id, router]
  );

  const handleGenerationComplete = useCallback(async () => {
    // Refetch the artifact to get the updated content
    const result = await getArtifactById(plan.id, { noCache: true });
    if (result.success) {
      setContent(result.data.content ?? "");
      setLastSaved(result.data.updatedAt);
      setStatus(result.data.status);
      // Increment key to force MDXEditor remount with new content
      setEditorKey((k) => k + 1);
      toast.success("Plan generation complete");
    }
  }, [plan.id]);

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
    showRequestChangesModal,
    setShowRequestChangesModal,
    isRequestingChanges,
    isDraft,
    generationStatus,
    editorKey,

    // Handlers
    handleSave,
    handleStatusChange,
    handleApproverChange,
    handleApproverBlur,
    handleApprove,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
    handleRegenerate,
    handleRequestChanges,
    handleGenerationComplete,
  };
}
