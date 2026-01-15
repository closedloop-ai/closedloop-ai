"use client";

import type {
  ImplementationPlanWithPrd,
  ImplPlanStatus,
  ImplPlanType,
} from "@repo/api/src/types/implementation-plan";
import { toast } from "@repo/design-system/components/ui/sonner";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import {
  deleteImplementationPlan,
  updateImplementationPlan,
} from "@/app/actions/implementation-plans";
import {
  copyToClipboard,
  downloadAsMarkdown,
} from "@/lib/clipboard-and-download-utils";

export function useImplementationPlanEditor(plan: ImplementationPlanWithPrd) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Content state
  const [content, setContent] = useState(plan.content);
  const [lastSaved, setLastSaved] = useState<Date>(plan.updatedAt);
  const [isSaving, setIsSaving] = useState(false);

  // Metadata state
  const [status, setStatus] = useState(plan.status);
  const [approver, setApprover] = useState(plan.approver || "");
  const [planType, setPlanType] = useState(plan.planType);
  const [targetRelease, setTargetRelease] = useState(plan.targetRelease || "");
  const [engineeringTeam, setEngineeringTeam] = useState(
    plan.engineeringTeam || ""
  );

  // UI state
  const [showMetadataPanel, setShowMetadataPanel] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const isDraft = status === "Draft";

  // Handlers
  const handleSave = useCallback(() => {
    setIsSaving(true);
    startTransition(async () => {
      const result = await updateImplementationPlan({ id: plan.id, content });
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
        status: ImplPlanStatus;
        approver: string;
        planType: ImplPlanType;
        targetRelease: string;
        engineeringTeam: string;
      }>
    ) => {
      startTransition(async () => {
        const result = await updateImplementationPlan({
          id: plan.id,
          ...updates,
        });
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
    (newStatus: ImplPlanStatus) => {
      setStatus(newStatus);
      handleMetadataUpdate({ status: newStatus });
    },
    [handleMetadataUpdate]
  );

  const handleApproverChange = useCallback((newApprover: string) => {
    setApprover(newApprover);
  }, []);

  const handleApproverBlur = useCallback(() => {
    if (approver !== (plan.approver || "")) {
      handleMetadataUpdate({ approver: approver || undefined });
    }
  }, [approver, plan.approver, handleMetadataUpdate]);

  const handlePlanTypeChange = useCallback(
    (newPlanType: ImplPlanType) => {
      setPlanType(newPlanType);
      handleMetadataUpdate({ planType: newPlanType });
    },
    [handleMetadataUpdate]
  );

  const handleTargetReleaseChange = useCallback((newTargetRelease: string) => {
    setTargetRelease(newTargetRelease);
  }, []);

  const handleTargetReleaseBlur = useCallback(() => {
    if (targetRelease !== (plan.targetRelease || "")) {
      handleMetadataUpdate({ targetRelease: targetRelease || undefined });
    }
  }, [targetRelease, plan.targetRelease, handleMetadataUpdate]);

  const handleEngineeringTeamChange = useCallback(
    (newEngineeringTeam: string) => {
      setEngineeringTeam(newEngineeringTeam);
    },
    []
  );

  const handleEngineeringTeamBlur = useCallback(() => {
    if (engineeringTeam !== (plan.engineeringTeam || "")) {
      handleMetadataUpdate({ engineeringTeam: engineeringTeam || undefined });
    }
  }, [engineeringTeam, plan.engineeringTeam, handleMetadataUpdate]);

  const handleApprove = useCallback(() => {
    startTransition(async () => {
      const result = await updateImplementationPlan({
        id: plan.id,
        status: "Ready",
      });
      if (result.success) {
        setStatus("Ready");
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
      `${plan.title.toLowerCase().replace(/\s+/g, "-")}.md`
    );
  }, [content, plan.title]);

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
      await deleteImplementationPlan(plan.id);
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
    planType,
    targetRelease,
    engineeringTeam,
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
    handlePlanTypeChange,
    handleTargetReleaseChange,
    handleTargetReleaseBlur,
    handleEngineeringTeamChange,
    handleEngineeringTeamBlur,
    handleApprove,
    handleExport,
    handleCopyMarkdown,
    handleDelete,
  };
}
