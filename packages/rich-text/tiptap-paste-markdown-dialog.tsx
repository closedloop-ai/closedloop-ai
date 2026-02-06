"use client";

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
import { useState } from "react";

type TiptapPasteMarkdownDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetContent: (markdown: string) => void;
};

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
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="flex max-h-[80vh] flex-col">
        <DialogHeader>
          <DialogTitle>Paste Markdown</DialogTitle>
          <DialogDescription>
            Paste your markdown content below to set it as the editor content.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          className="max-h-[50vh] min-h-[200px] resize-none font-mono text-sm"
          onChange={(e) => setMarkdownInput(e.target.value)}
          placeholder="Paste your markdown here..."
          value={markdownInput}
        />
        <DialogFooter>
          <Button onClick={handleCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!markdownInput.trim()}
            onClick={handleSetMarkdownContent}
            type="button"
          >
            Set Content
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
