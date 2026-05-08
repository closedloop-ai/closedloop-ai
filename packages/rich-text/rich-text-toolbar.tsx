import { useState } from "react";
import { TiptapPasteMarkdownDialog } from "./tiptap-paste-markdown-dialog";
import { TiptapToolbar, type TiptapToolbarProps } from "./tiptap-toolbar";

type RichTextToolbarProps = Omit<TiptapToolbarProps, "onPasteMarkdown"> & {
  onPasteMarkdown: (markdown: string) => void;
};

export function RichTextToolbar({
  onPasteMarkdown,
  ...props
}: RichTextToolbarProps) {
  const [showPasteMarkdownDialog, setShowPasteMarkdownDialog] = useState(false);

  return (
    <>
      <TiptapToolbar
        {...props}
        onPasteMarkdown={() => setShowPasteMarkdownDialog(true)}
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
