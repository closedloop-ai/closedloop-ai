"use client";

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
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Badge } from "@repo/design-system/components/ui/badge";
import { LoaderIcon, PlusIcon, XIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createPRD } from "@/app/actions/prds";

const STATUS_OPTIONS = ["Draft", "Review", "Approved", "Archived"];
const TEMPLATE_OPTIONS = ["Standard PRD", "Feature Brief", "Bug Fix", "Technical Spec"];

export function NewPRDModal() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [fileName, setFileName] = useState("");
  const [approver, setApprover] = useState("");
  const [status, setStatus] = useState("Draft");
  const [template, setTemplate] = useState("Standard PRD");
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
    setStatus("Draft");
    setTemplate("Standard PRD");
    setTags([]);
    setNewTag("");
    setContent("");
    setError(null);
  };

  const handleSubmit = () => {
    setError(null);

    if (!title.trim() || !fileName.trim() || !approver.trim()) {
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

        if (result.error) {
          setError(result.error);
          return;
        }

        if (result.data) {
          setOpen(false);
          resetForm();
          router.push(`/prds/${result.data.id}`);
        }
      } catch (err) {
        console.error("Failed to create PRD:", err);
        setError("An unexpected error occurred");
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(newOpen) => {
      setOpen(newOpen);
      if (!newOpen) {
        resetForm();
      }
    }}>
      <DialogTrigger asChild>
        <Button>
          <PlusIcon className="mr-2 h-4 w-4" />
          New PRD
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create New PRD</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="new-title">
              Title<span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-title"
              value={title}
              onChange={(e) => handleTitleChange(e.target.value)}
              placeholder="Checkout Revamp"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-filename">
              File name<span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-filename"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="checkout-revamp.md"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-approver">
              Approver<span className="text-destructive">*</span>
            </Label>
            <Input
              id="new-approver"
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
              placeholder="Approver name"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt} value={opt}>
                      {opt}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Template</Label>
              <Select value={template} onValueChange={setTemplate}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_OPTIONS.map((opt) => (
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
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add tag"
                className="flex-1"
              />
              <Button type="button" variant="outline" onClick={handleAddTag}>
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag)}
                      className="ml-1 hover:text-destructive"
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
              Initial Content <span className="text-muted-foreground text-xs">(optional - paste markdown here)</span>
            </Label>
            <Textarea
              id="new-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# My PRD&#10;&#10;## Problem&#10;&#10;Describe the problem..."
              className="min-h-[150px] font-mono text-sm"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !title.trim() || !fileName.trim() || !approver.trim()}
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
