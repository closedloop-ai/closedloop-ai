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
import { Input } from "@repo/design-system/components/ui/input";
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
import { useEffect, useState } from "react";
import {
  useArtifactsBySubtype,
  useCreateAndGenerateArtifact,
} from "@/hooks/queries/use-artifacts";
import { getUserDisplayName } from "@/lib/user-utils";

type NewPlanModalProps = {
  sourceArtifact?: ArtifactWithWorkstream;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function generatePlanFileName(prd: ArtifactWithWorkstream): string {
  if (prd.fileName) {
    return prd.fileName.replace(".md", "-impl-plan.md");
  }
  return `${prd.title
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, "")
    .replaceAll(/\s+/g, "-")}-impl-plan.md`;
}

function PrdSelector({
  prds,
  isLoading,
  selectedPrdId,
  onSelect,
}: {
  prds: ArtifactWithWorkstream[];
  isLoading: boolean;
  selectedPrdId: string;
  onSelect: (id: string) => void;
}) {
  const placeholder = isLoading ? "Loading PRDs..." : "Select a PRD";
  const isEmpty = prds.length === 0 && !isLoading;

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

function PlanPreview({
  prd,
  title,
  fileName,
}: {
  prd: ArtifactWithWorkstream;
  title: string;
  fileName: string;
}) {
  return (
    <div className="rounded-md border bg-muted/50 p-3 text-sm">
      <p className="mb-1 font-medium">Plan will be created with:</p>
      <ul className="space-y-1 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Title:</span>{" "}
          {title || (
            <span className="text-muted-foreground italic">
              No title entered
            </span>
          )}
        </li>
        <li>
          <span className="font-medium text-foreground">File name:</span>{" "}
          {fileName || (
            <span className="text-muted-foreground italic">Auto-generated</span>
          )}
        </li>
        {prd.approver ? (
          <li>
            <span className="font-medium text-foreground">Approver:</span>{" "}
            {getUserDisplayName(prd.approver)}
          </li>
        ) : null}
        {prd.targetRepo ? (
          <li>
            <span className="font-medium text-foreground">Target Repo:</span>{" "}
            {prd.targetRepo}
          </li>
        ) : null}
        {prd.targetBranch ? (
          <li>
            <span className="font-medium text-foreground">Target Branch:</span>{" "}
            {prd.targetBranch}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function NewPlanModal({
  sourceArtifact,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: NewPlanModalProps = {}) {
  const router = useRouter();
  const createAndGeneratePlan = useCreateAndGenerateArtifact();
  const [internalOpen, setInternalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Support both controlled and uncontrolled modes
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = controlledOnOpenChange ?? setInternalOpen;

  // Form state
  const [selectedSourceId, setSelectedSourceId] = useState(
    sourceArtifact?.id ?? ""
  );
  const [title, setTitle] = useState(() =>
    sourceArtifact ? `Implementation Plan: ${sourceArtifact.title}` : ""
  );
  const [fileName, setFileName] = useState(() =>
    sourceArtifact ? generatePlanFileName(sourceArtifact) : ""
  );
  const [content, setContent] = useState("");

  // Fetch PRDs when modal opens (skip if we have a source artifact)
  const { data: prds = [], isLoading: loadingPrds } = useArtifactsBySubtype(
    "PRD",
    true,
    {
      enabled: open && !sourceArtifact,
    }
  );

  // Get the selected source (either from prop or from dropdown)
  const selectedSource =
    sourceArtifact ?? prds.find((p) => p.id === selectedSourceId);

  // Update title and filename when source is selected from dropdown
  useEffect(() => {
    if (selectedSource && !sourceArtifact) {
      setTitle(`Implementation Plan: ${selectedSource.title}`);
      setFileName(generatePlanFileName(selectedSource));
    }
  }, [selectedSource, sourceArtifact]);

  const handleTitleChange = (value: string): void => {
    setTitle(value);
    if (value.trim()) {
      const generatedFileName = value
        .toLowerCase()
        .replaceAll(/[^a-z0-9\s]/g, "")
        .replaceAll(/\s+/g, "-")
        .concat("-impl-plan.md");
      setFileName(generatedFileName);
    } else {
      setFileName("");
    }
  };

  const resetForm = () => {
    setSelectedSourceId(sourceArtifact?.id ?? "");
    setTitle("");
    setFileName("");
    setContent("");
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);

    if (!selectedSource) {
      setError("Please select a source PRD");
      return;
    }

    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    // Fallback fileName in case useEffect hasn't populated it yet
    const finalFileName =
      fileName.trim() || generatePlanFileName(selectedSource);

    createAndGeneratePlan.mutate(
      {
        subtype: "IMPLEMENTATION_PLAN",
        title: title.trim(),
        fileName: finalFileName,
        approverId: selectedSource.approver?.id,
        status: "DRAFT",
        content: content.trim() || "",
        parentId: selectedSource.id,
        projectId: selectedSource.projectId ?? undefined,
        workstreamId: selectedSource.workstreamId ?? undefined,
        targetRepo: selectedSource.targetRepo ?? undefined,
        targetBranch: selectedSource.targetBranch ?? undefined,
      },
      {
        onSuccess: (artifact) => {
          setOpen(false);
          resetForm();
          router.push(`/implementation-plans/${artifact.documentSlug}`);
        },
      }
    );
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
            Create an implementation plan from a PRD or Issue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div
              className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm"
              id="title-error"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-title">
              Title<span className="text-destructive">*</span>
            </Label>
            <Input
              aria-describedby={error ? "title-error" : ""}
              aria-invalid={error ? "true" : "false"}
              id="new-title"
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Implementation Plan: Dashboard Redesign"
              value={title}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-filename">File name</Label>
            <Input
              id="new-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder={fileName || "dashboard-redesign-impl-plan.md"}
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="source-prd">
              Source{sourceArtifact ? "" : " PRD"}
              <span className="text-destructive">*</span>
            </Label>
            {sourceArtifact ? (
              <div className="flex h-10 w-full items-center rounded-md border border-input bg-muted px-3 py-2 text-sm">
                {sourceArtifact.title}
              </div>
            ) : (
              <PrdSelector
                isLoading={loadingPrds}
                onSelect={setSelectedSourceId}
                prds={prds}
                selectedPrdId={selectedSourceId}
              />
            )}
          </div>

          {selectedSource ? (
            <PlanPreview
              fileName={fileName}
              prd={selectedSource}
              title={title}
            />
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-content">Additional context</Label>
            <Textarea
              className="min-h-[150px] font-mono text-sm"
              id="new-content"
              onChange={(e) => setContent(e.target.value)}
              value={content}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              createAndGeneratePlan.isPending ||
              !selectedSource ||
              !title.trim()
            }
            onClick={handleSubmit}
          >
            {createAndGeneratePlan.isPending ? (
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
