"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { LoaderIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import {
  createAndGeneratePlan,
  getArtifactsByType,
} from "@/app/actions/artifacts";

type NewPlanModalProps = {
  // When sourcePrd is provided, the modal is used from a PRD page
  sourcePrd?: ArtifactWithWorkstream;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function generatePlanFileName(prd: ArtifactWithWorkstream): string {
  if (prd.fileName) {
    return prd.fileName.replace(".md", "-impl-plan.md");
  }
  return `${prd.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "-")}-impl-plan.md`;
}

function PrdSelector({
  prds,
  loadingPrds,
  selectedPrdId,
  onSelect,
}: {
  prds: ArtifactWithWorkstream[];
  loadingPrds: boolean;
  selectedPrdId: string;
  onSelect: (id: string) => void;
}) {
  const placeholder = loadingPrds ? "Loading PRDs..." : "Select a PRD";
  const isEmpty = prds.length === 0 && !loadingPrds;

  return (
    <Select onValueChange={onSelect} value={selectedPrdId}>
      <SelectTrigger id="source-prd">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {isEmpty ? (
          <div className="p-2 text-center text-muted-foreground text-sm">
            No PRDs available. Create a PRD first.
          </div>
        ) : null}
        {prds.map((prd) => (
          <SelectItem key={prd.id} value={prd.id}>
            {prd.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PlanPreview({ prd }: { prd: ArtifactWithWorkstream }) {
  return (
    <div className="rounded-md border bg-muted/50 p-3 text-sm">
      <p className="mb-1 font-medium">Plan will be created with:</p>
      <ul className="space-y-1 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Title:</span>{" "}
          Implementation Plan: {prd.title}
        </li>
        {prd.approver ? (
          <li>
            <span className="font-medium text-foreground">Approver:</span>{" "}
            {prd.approver}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function NewPlanModal({
  sourcePrd,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: NewPlanModalProps = {}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [internalOpen, setInternalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Support both controlled and uncontrolled modes
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;

  // Form state
  const [selectedPrdId, setSelectedPrdId] = useState(sourcePrd?.id ?? "");
  const [content, setContent] = useState("");

  // PRDs for dropdown (when not pre-selected)
  const [prds, setPrds] = useState<ArtifactWithWorkstream[]>([]);
  const [loadingPrds, setLoadingPrds] = useState(false);

  // Load PRDs when modal opens (skip if we have a source PRD)
  useEffect(() => {
    if (!open || sourcePrd) {
      return;
    }
    setLoadingPrds(true);
    getArtifactsByType("PRD").then((result) => {
      if (result.success) {
        setPrds(result.data);
      }
      setLoadingPrds(false);
    });
  }, [open, sourcePrd]);

  // Get the selected PRD (either from prop or from dropdown)
  const selectedPrd = sourcePrd ?? prds.find((p) => p.id === selectedPrdId);

  const resetForm = () => {
    setSelectedPrdId(sourcePrd?.id ?? "");
    setContent("");
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);

    if (!selectedPrd) {
      setError("Please select a source PRD");
      return;
    }

    startTransition(async () => {
      try {
        // Use createAndGeneratePlan to create artifact AND trigger workflow
        const result = await createAndGeneratePlan({
          type: "IMPLEMENTATION_PLAN",
          title: `Implementation Plan: ${selectedPrd.title}`,
          fileName: generatePlanFileName(selectedPrd),
          approver: selectedPrd.approver ?? undefined,
          status: "DRAFT",
          // Pass content as initial instructions (not placeholder template)
          // The regenerate endpoint will use this as additional context
          content: content.trim() || "",
          // Link to PRD's workstream for proper regenerate flow
          workstreamId: selectedPrd.workstreamId ?? undefined,
        });

        if (!result.success) {
          setError(result.error);
          return;
        }

        setOpen(false);
        resetForm();
        router.push(`/implementation-plans/${result.data.id}`);
      } catch (err) {
        console.error("Failed to create implementation plan:", err);
        setError("An unexpected error occurred");
      }
    });
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      resetForm();
    }
  };

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button>
            <PlusIcon className="mr-2 h-4 w-4" />
            New Plan
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              <SparklesIcon className="h-5 w-5" />
              Generate Implementation Plan
            </div>
          </DialogTitle>
          <DialogDescription>
            Create an implementation plan from a PRD. The plan will inherit the
            title and approver from the selected PRD.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="source-prd">
              Source PRD<span className="text-destructive">*</span>
            </Label>
            {sourcePrd ? (
              <div className="flex h-10 w-full items-center rounded-md border border-input bg-muted px-3 py-2 text-sm">
                {sourcePrd.title}
              </div>
            ) : (
              <PrdSelector
                loadingPrds={loadingPrds}
                onSelect={setSelectedPrdId}
                prds={prds}
                selectedPrdId={selectedPrdId}
              />
            )}
          </div>

          {selectedPrd ? <PlanPreview prd={selectedPrd} /> : null}

          <div className="space-y-2">
            <Label htmlFor="new-content">
              Initial Content{" "}
              <span className="text-muted-foreground text-xs">
                (optional - paste or write markdown)
              </span>
            </Label>
            <Textarea
              className="min-h-[150px] font-mono text-sm"
              id="new-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Implementation Plan&#10;&#10;## Overview&#10;&#10;Describe the implementation approach..."
              value={content}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={isPending || !selectedPrd} onClick={handleSubmit}>
            {isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <SparklesIcon className="mr-2 h-4 w-4" />
                Generate Plan
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
