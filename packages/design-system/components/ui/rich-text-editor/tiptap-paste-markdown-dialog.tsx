"use client";

import { useState } from "react";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Textarea } from "@repo/design-system/components/ui/textarea";

interface TiptapPasteMarkdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetContent: (markdown: string) => void;
}

export function TiptapPasteMarkdownDialog({
  open,
  onOpenChange,
  onSetContent,
}: Readonly<TiptapPasteMarkdownDialogProps>) {
  const [markdownInput, setMarkdownInput] = useState("");

  function handleSetMarkdownContent() {
    if (markdownInput) {
      onSetContent(markdownInput);
      setMarkdownInput("");
      onOpenChange(false);
    }
  }

  function handleCancel() {
    setMarkdownInput("");
    onOpenChange(false);
  }

  function handleOpenChange(newOpen: boolean) {
    if (!newOpen) {
      setMarkdownInput("");
    }
    onOpenChange(newOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Paste Markdown</DialogTitle>
          <DialogDescription>
            Paste your markdown content below to set it as the editor content.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={markdownInput}
          onChange={(e) => setMarkdownInput(e.target.value)}
          placeholder="Paste your markdown here..."
          className="min-h-[200px] max-h-[50vh] font-mono text-sm resize-none"
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSetMarkdownContent}
            disabled={!markdownInput.trim()}
          >
            Set Content
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
