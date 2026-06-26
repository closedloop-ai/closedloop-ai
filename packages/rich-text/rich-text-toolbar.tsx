"use client";

import { useState } from "react";
import { TiptapPasteMarkdownDialog } from "./tiptap-paste-markdown-dialog";
import { TiptapToolbar, type TiptapToolbarProps } from "./tiptap-toolbar";

type RichTextToolbarProps = Omit<TiptapToolbarProps, "onPasteMarkdown"> & {
  onUploadInlineImage?: (file: File) => void;
  onPasteMarkdown: (markdown: string) => void;
};

export function RichTextToolbar({
  onPasteMarkdown,
  onUploadInlineImage,
  ...props
}: RichTextToolbarProps) {
  const [showPasteMarkdownDialog, setShowPasteMarkdownDialog] = useState(false);

  return (
    <>
      <TiptapToolbar
        {...props}
        onPasteMarkdown={() => setShowPasteMarkdownDialog(true)}
        onUploadInlineImage={onUploadInlineImage}
      />

      {onPasteMarkdown && (
        <TiptapPasteMarkdownDialog
          onOpenChange={setShowPasteMarkdownDialog}
          onSetContent={onPasteMarkdown}
          open={showPasteMarkdownDialog}
        />
      )}
    </>
  );
}
