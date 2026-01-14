"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
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
import { LoaderIcon, PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createPRD } from "@/app/actions/prds";
import {
  PRD_STATUS_OPTIONS,
  PRD_TEMPLATE_OPTIONS,
  type PRDStatus,
  type PRDTemplate,
} from "@/lib/types";

export function NewPRDModal() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [approver, setApprover] = useState("");
  const [status, setStatus] = useState<PRDStatus>("Draft");
  const [template, setTemplate] = useState<PRDTemplate>("Standard PRD");
  const [tags, setTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState("");
  const [content, setContent] = useState("");

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

  const handleAddTag = () => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      setTags([...tags, newTag.trim()]);
      setNewTag("");
    }
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((tag) => tag !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddTag();
    }
  };

  const resetForm = () => {
    setTitle("");
    setFileName("");
    setApprover("");
    setStatus("Draft" as PRDStatus);
    setTemplate("Standard PRD" as PRDTemplate);
    setTags([]);
    setNewTag("");
    setContent("");
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);

    if (!(title.trim() && fileName.trim() && approver.trim())) {
      setError("Please fill in all required fields");
      return;
    }

    startTransition(async () => {
      try {
        const result = await createPRD({
          title: title.trim(),
          fileName: fileName.trim(),
          approver: approver.trim(),
          status,
          template,
          tags,
          content: content.trim() || undefined,
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
          {error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm">
              {error}
            </div>
          )}

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
            <Label htmlFor="new-filename">
              File name<span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-filename"
              onChange={(e) => setFileName(e.target.value)}
              placeholder="checkout-revamp.md"
              value={fileName}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-approver">
              Approver<span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-approver"
              onChange={(e) => setApprover(e.target.value)}
              placeholder="Approver name"
              value={approver}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select
                onValueChange={(v) => setStatus(v as PRDStatus)}
                value={status}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRD_STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Template</Label>
              <Select
                onValueChange={(v) => setTemplate(v as PRDTemplate)}
                value={template}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRD_TEMPLATE_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Tags</Label>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add tag"
                value={newTag}
              />
              <Button onClick={handleAddTag} type="button" variant="outline">
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {tags.map((tag) => (
                  <Badge className="gap-1" key={tag} variant="secondary">
                    {tag}
                    <button
                      className="ml-1 hover:text-destructive"
                      onClick={() => handleRemoveTag(tag)}
                      type="button"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-content">
              Initial Content{" "}
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
          <Button
            disabled={
              isPending || !title.trim() || !fileName.trim() || !approver.trim()
            }
            onClick={handleSubmit}
          >
            {isPending ? (
              <>
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
                Creating...
              </>
            ) : (
              "Create & Edit"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
