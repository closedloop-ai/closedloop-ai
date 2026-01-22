"use client";

import { ArtifactStatus } from "@repo/api/src/types/artifact";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { LoaderIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createArtifact } from "@/app/actions/artifacts";

export function NewPRDModal() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [approver, setApprover] = useState("");
  const [status, setStatus] = useState<ArtifactStatus>("DRAFT");
  const [content, setContent] = useState("");
  const [targetRepo, setTargetRepo] = useState("");
  const [targetBranch, setTargetBranch] = useState("main");

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
    setApprover("");
    setStatus("DRAFT");
    setContent("");
    setTargetRepo("");
    setTargetBranch("main");
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);

    if (!title.trim()) {
      setError("Please enter a title");
      return;
    }

    startTransition(async () => {
      try {
        const result = await createArtifact({
          type: "PRD",
          title: title.trim(),
          fileName: fileName.trim() || undefined,
          approver: approver.trim() || undefined,
          status,
          content: content.trim() || undefined,
          targetRepo: targetRepo.trim() || undefined,
          targetBranch: targetBranch.trim() || undefined,
        });

        if (!result.success) {
          setError(result.error);
          return;
        }

        setOpen(false);
        resetForm();
        router.push(`/prds/${result.data.id}`);
      } catch (err) {
        console.error("Failed to create PRD:", err);
        setError("An unexpected error occurred");
      }
    });
  };

  return (
    <Dialog
      onOpenChange={(newOpen) => {
        setOpen(newOpen);
        if (!newOpen) {
          resetForm();
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="mr-2 h-4 w-4" />
          New PRD
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Create New PRD</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="new-title">
              Title<span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-title"
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Checkout Revamp"
              value={title}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-filename">File name</Label>
            <Input
              id="new-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder="checkout-revamp.md"
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-approver">Approver</Label>
            <Input
              id="new-approver"
              onChange={(e) => setApprover(e.target.value)}
              placeholder="Approver name"
              value={approver}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-target-repo">
              Target Repository{" "}
              <span className="text-muted-foreground text-xs">
                (for plan generation)
              </span>
            </Label>
            <Input
              id="new-target-repo"
              onChange={(e) => setTargetRepo(e.target.value)}
              placeholder="owner/repo"
              value={targetRepo}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-target-branch">Target Branch</Label>
            <Input
              id="new-target-branch"
              onChange={(e) => setTargetBranch(e.target.value)}
              placeholder="main"
              value={targetBranch}
            />
          </div>

          <div className="space-y-2">
            <Label>Status</Label>
            <Select
              onValueChange={(v) => setStatus(v as ArtifactStatus)}
              value={status}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.values(ArtifactStatus).map((statusOption) => (
                  <SelectItem key={statusOption} value={statusOption}>
                    {statusOption.charAt(0) +
                      statusOption.slice(1).toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-content">
              Content{" "}
              <span className="text-muted-foreground text-xs">
                (optional - paste markdown here)
              </span>
            </Label>
            <Textarea
              className="min-h-[150px] font-mono text-sm"
              id="new-content"
              onChange={(e) => setContent(e.target.value)}
              placeholder="# My PRD&#10;&#10;## Problem&#10;&#10;Describe the problem..."
              value={content}
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => setOpen(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={isPending || !title.trim()} onClick={handleSubmit}>
            {isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create PRD"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
