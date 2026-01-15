"use client";

import type { Prd, PrdStatus, PrdTemplate } from "@repo/api/src/types/prd";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  deletePRD,
  duplicatePRD,
  renamePRD,
  updatePRD,
} from "@/app/actions/prds";
import {
  copyToClipboard,
  downloadAsMarkdown,
} from "@/lib/clipboard-and-download-utils";

export function usePRDEditor(prd: Prd) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Content state
  const [content, setContent] = useState(prd.content);
  const [lastSaved, setLastSaved] = useState<Date>(prd.updatedAt);
  const [isSaving, setIsSaving] = useState(false);

  // Metadata state
  const [status, setStatus] = useState(prd.status);
  const [approver, setApprover] = useState(prd.approver);
  const [tags, setTags] = useState<string[]>(prd.tags ?? []);
  const [template, setTemplate] = useState(prd.template);
  const [newTag, setNewTag] = useState("");

  // UI state
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showGeneratePlanModal, setShowGeneratePlanModal] = useState(false);

  // Handlers
  const handleSave = useCallback(() => {
    setIsSaving(true);
    startTransition(async () => {
      const result = await updatePRD({ id: prd.id, content });
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
        status: PrdStatus;
        approver: string;
        tags: string[];
        template: PrdTemplate;
      }>
    ) => {
      startTransition(async () => {
        const result = await updatePRD({ id: prd.id, ...updates });
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
    (newStatus: PrdStatus) => {
      setStatus(newStatus);
      handleMetadataUpdate({ status: newStatus });
    },
    [handleMetadataUpdate]
  );

  const handleApproverChange = useCallback((newApprover: string) => {
    setApprover(newApprover);
  }, []);

  const handleApproverBlur = useCallback(() => {
    if (approver !== prd.approver) {
      handleMetadataUpdate({ approver });
    }
  }, [approver, prd.approver, handleMetadataUpdate]);

  const handleTemplateChange = useCallback(
    (newTemplate: PrdTemplate) => {
      setTemplate(newTemplate);
      handleMetadataUpdate({ template: newTemplate });
    },
    [handleMetadataUpdate]
  );

  const handleAddTag = useCallback(() => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      const updatedTags = [...tags, newTag.trim()];
      setTags(updatedTags);
      setNewTag("");
      handleMetadataUpdate({ tags: updatedTags });
    }
  }, [newTag, tags, handleMetadataUpdate]);

  const handleRemoveTag = useCallback(
    (tagToRemove: string) => {
      const updatedTags = tags.filter((tag) => tag !== tagToRemove);
      setTags(updatedTags);
      handleMetadataUpdate({ tags: updatedTags });
    },
    [tags, handleMetadataUpdate]
  );

  const handleTagKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAddTag();
      }
    },
    [handleAddTag]
  );

  const handleRename = useCallback(
    (title: string, fileName: string) => {
      startTransition(async () => {
        await renamePRD(prd.id, title, fileName);
        setShowRenameDialog(false);
      });
    },
    [prd.id]
  );

  const handleDuplicate = useCallback(() => {
    startTransition(async () => {
      const result = await duplicatePRD(prd.id);
      if (result.success) {
        router.push(`/prds/${result.data.id}`);
      }
    });
  }, [prd.id, router]);

  const handleExport = useCallback(() => {
    downloadAsMarkdown(content, prd.fileName);
  }, [content, prd.fileName]);

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
      await deletePRD(prd.id);
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
    tags,
    template,
    newTag,
    setNewTag,
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
    handleTemplateChange,
    handleAddTag,
    handleRemoveTag,
    handleTagKeyDown,
    handleRename,
    handleDuplicate,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
  };
}
