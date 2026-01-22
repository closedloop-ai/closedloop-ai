"use client";

import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { LoaderIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { createArtifact, getArtifactsByProject } from "@/app/actions/artifacts";

const ARTIFACT_TYPE_LABELS: Record<string, string> = {
  PRD: "PRD",
  IMPLEMENTATION_PLAN: "Implementation Plan",
};

function PrdSelectContent({
  loading,
  prds,
}: {
  loading: boolean;
  prds: ArtifactWithWorkstream[];
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center p-2">
        <LoaderIcon className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (prds.length === 0) {
    return (
      <div className="p-2 text-center text-muted-foreground text-sm">
        No PRDs in this project. Create a PRD first.
      </div>
    );
  }
  return (
    <>
      {prds.map((prd) => (
        <SelectItem key={prd.id} value={prd.id}>
          {prd.title}
        </SelectItem>
      ))}
    </>
  );
}

type CreateArtifactModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifactType: ArtifactType;
  projectId: string;
  onSuccess?: (artifact: Artifact) => void;
};

export function CreateArtifactModal({
  open,
  onOpenChange,
  artifactType,
  projectId,
  onSuccess,
}: CreateArtifactModalProps) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");

  // PRD selection for implementation plans
  const [prds, setPrds] = useState<ArtifactWithWorkstream[]>([]);
  const [selectedPrdId, setSelectedPrdId] = useState<string>("");
  const [loadingPrds, setLoadingPrds] = useState(false);

  const typeLabel = ARTIFACT_TYPE_LABELS[artifactType] || artifactType;
  const isImplementationPlan = artifactType === "IMPLEMENTATION_PLAN";

  // Fetch PRDs when modal opens for implementation plan
  useEffect(() => {
    if (open && isImplementationPlan) {
      setLoadingPrds(true);
      getArtifactsByProject(projectId).then((result) => {
        if (result.success) {
          const projectPrds = result.data.filter((a) => a.type === "PRD");
          setPrds(projectPrds);
        }
        setLoadingPrds(false);
      });
    }
  }, [open, isImplementationPlan, projectId]);

  const handleTitleChange = (value: string) => {
    setTitle(value);
    // Auto-generate filename from title
    if (value.trim()) {
      const generatedFileName = value
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, "-")
        .concat(".md");
      setFileName(generatedFileName);
    }
  };

  const resetForm = () => {
    setTitle("");
    setFileName("");
    setContent("");
    setSelectedPrdId("");
    setError(null);
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = () => {
    setError(null);

    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    if (isImplementationPlan && !selectedPrdId) {
      setError("Please select a PRD");
      return;
    }

    startTransition(async () => {
      try {
        const result = await createArtifact({
          projectId,
          type: artifactType,
          title: title.trim(),
          fileName: fileName.trim() || undefined,
          content: content.trim() || undefined,
          sourcePrdId: isImplementationPlan ? selectedPrdId : undefined,
        });

        if (!result.success) {
          setError(result.error);
          return;
        }

        handleClose();
        onSuccess?.(result.data);
      } catch (err) {
        console.error(`Failed to create ${typeLabel}:`, err);
        setError("An unexpected error occurred");
      }
    });
  };

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        if (newOpen) {
          onOpenChange(true);
        } else {
          handleClose();
        }
      }}
      open={open}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create {typeLabel}</DialogTitle>
          <DialogDescription>
            Create a new {typeLabel.toLowerCase()} for this project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          {isImplementationPlan ? (
            <div className="space-y-2">
              <Label htmlFor="source-prd">
                Source PRD<span className="text-destructive">*</span>
              </Label>
              <Select onValueChange={setSelectedPrdId} value={selectedPrdId}>
                <SelectTrigger id="source-prd">
                  <SelectValue placeholder="Select a PRD..." />
                </SelectTrigger>
                <SelectContent>
                  <PrdSelectContent loading={loadingPrds} prds={prds} />
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                The implementation plan will be generated from this PRD.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="artifact-title">
              Title<span className="text-destructive">*</span>
            </Label>
            <Input
              id="artifact-title"
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder={`Enter ${typeLabel.toLowerCase()} title`}
              value={title}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="artifact-filename">File name</Label>
            <Input
              id="artifact-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder="auto-generated-from-title.md"
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="artifact-content">
              Content{" "}
              <span className="text-muted-foreground text-xs">(optional)</span>
            </Label>
            <Textarea
              className="min-h-[120px] font-mono text-sm"
              id="artifact-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste markdown content here..."
              value={content}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={
              isPending ||
              !title.trim() ||
              (isImplementationPlan ? !selectedPrdId : false)
            }
            onClick={handleSubmit}
          >
            {isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              `Create ${typeLabel}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
