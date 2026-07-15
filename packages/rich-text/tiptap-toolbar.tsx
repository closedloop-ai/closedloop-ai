"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import type { Editor } from "@tiptap/react";
import type { LucideIcon } from "lucide-react";
import {
  Bold,
  Code,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  MessageSquarePlus,
  Network,
  Quote,
  Redo,
  Table as TableIcon,
  Undo,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { sanitizeLinkUrl } from "./sanitize-link-url";
import type { TiptapEditor } from "./types";

export type TiptapToolbarProps = {
  editor: Editor | null;
  readOnly?: boolean;
  hasLiveblocksExtension?: boolean;
  onPasteMarkdown?: () => void;
  onUploadInlineImage?: (file: File) => void;
  className?: string;
};

export function TiptapToolbar({
  editor,
  readOnly = false,
  hasLiveblocksExtension = false,
  onPasteMarkdown,
  onUploadInlineImage,
  className,
}: Readonly<TiptapToolbarProps>) {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [editorUploadHandler, setEditorUploadHandler] = useState<
    ((file: File) => Promise<void>) | undefined
  >();
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const updateHistoryState = useCallback(() => {
    if (!editor) {
      setCanUndo(false);
      setCanRedo(false);
      setEditorUploadHandler(undefined);
      return;
    }
    setCanUndo(editor.can().undo());
    setCanRedo(editor.can().redo());
    setEditorUploadHandler(() =>
      readOnly ? undefined : (editor as TiptapEditor).insertInlineImageFile
    );
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    updateHistoryState();
    editor.on("transaction", updateHistoryState);
    return () => {
      editor.off("transaction", updateHistoryState);
    };
  }, [editor, updateHistoryState]);

  function toggleLink() {
    const previousUrl = editor?.getAttributes("link").href as
      | string
      | undefined;
    // biome-ignore lint/suspicious/noAlert: usage of prompt is fine for now.
    const url = globalThis.prompt("URL", previousUrl);

    if (url === null) {
      return;
    }

    // Trim before the empty check so a whitespace-only entry ("   ") clears the
    // link, matching sanitizeLinkUrl()'s own trim-then-validate behavior.
    if (url.trim() === "") {
      editor?.chain().extendMarkRange("link").unsetLink().run();
      return;
    }

    const safeUrl = sanitizeLinkUrl(url);
    if (safeUrl === null) {
      // sanitizeLinkUrl rejected the input (empty after trimming, or a blocked
      // scheme like javascript:/data:/vbscript:). Tell the user the link was
      // not applied so a rejected entry isn't mistaken for a successful one.
      // biome-ignore lint/suspicious/noAlert: matches the prompt() used above.
      globalThis.alert(
        "That link could not be added. Enter a valid URL — javascript:, data: and vbscript: links are not allowed."
      );
      return;
    }

    editor?.chain().extendMarkRange("link").setLink({ href: safeUrl }).run();
  }

  const uploadHandler = readOnly
    ? undefined
    : (onUploadInlineImage ?? editorUploadHandler);

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex flex-wrap gap-1 border-b bg-background p-2",
          className
        )}
      >
        <ToolbarButton
          disabled={readOnly || !canUndo}
          icon={Undo}
          label="Undo"
          onClick={() => editor?.commands.undo()}
        />
        <ToolbarButton
          disabled={readOnly || !canRedo}
          icon={Redo}
          label="Redo"
          onClick={() => editor?.commands.redo()}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={readOnly}
          icon={Heading1}
          label="Heading 1"
          onClick={() => editor?.commands.toggleHeading({ level: 1 })}
        />
        <ToolbarButton
          disabled={readOnly}
          icon={Heading2}
          label="Heading 2"
          onClick={() => editor?.commands.toggleHeading({ level: 2 })}
        />
        <ToolbarButton
          disabled={readOnly}
          icon={Heading3}
          label="Heading 3"
          onClick={() => editor?.commands.toggleHeading({ level: 3 })}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={readOnly}
          icon={Bold}
          label="Bold"
          onClick={() => editor?.commands.toggleBold()}
        />
        <ToolbarButton
          disabled={readOnly}
          icon={Italic}
          label="Italic"
          onClick={() => editor?.commands.toggleItalic()}
        />
        <ToolbarButton
          disabled={readOnly}
          icon={Code}
          label="Inline Code"
          onClick={() => editor?.commands.toggleCode()}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={readOnly}
          icon={List}
          label="Bullet List"
          onClick={() => editor?.commands.toggleBulletList()}
        />
        <ToolbarButton
          disabled={readOnly}
          icon={ListOrdered}
          label="Numbered List"
          onClick={() => editor?.commands.toggleOrderedList()}
        />
        <ToolbarDivider />
        <ToolbarButton
          disabled={readOnly}
          icon={Quote}
          label="Blockquote"
          onClick={() => editor?.commands.toggleBlockquote()}
        />
        <ToolbarButton
          disabled={readOnly}
          icon={LinkIcon}
          label="Link"
          onClick={toggleLink}
        />
        <ToolbarButton
          disabled={readOnly}
          icon={TableIcon}
          label="Insert Table"
          onClick={() =>
            editor?.commands.insertTable({
              rows: 3,
              cols: 3,
              withHeaderRow: true,
            })
          }
        />
        {uploadHandler && (
          <ToolbarButton
            disabled={readOnly}
            icon={ImagePlus}
            label="Insert Image"
            onClick={() => imageInputRef.current?.click()}
          />
        )}
        <ToolbarDivider />
        <ToolbarButton
          disabled={readOnly}
          icon={Network}
          label="Insert Mermaid Diagram"
          onClick={() =>
            editor?.commands.insertContent({
              type: "mermaid",
              attrs: { content: "graph TD\n    A[Start] --> B[End]" },
            })
          }
        />
        {onPasteMarkdown && (
          <>
            <ToolbarDivider />
            <ToolbarButton
              disabled={readOnly}
              icon={FileText}
              label="Paste Markdown"
              onClick={onPasteMarkdown}
            />
          </>
        )}
        {hasLiveblocksExtension && (
          <ToolbarButton
            disabled={readOnly}
            icon={MessageSquarePlus}
            label="Add Comment"
            onClick={() => {
              // addPendingComment is added by the Liveblocks extension at
              // runtime; guard the call so a missing/unregistered extension
              // is a no-op rather than a TypeError.
              (
                editor?.commands as
                  | { addPendingComment?: () => void }
                  | undefined
              )?.addPendingComment?.();
            }}
          />
        )}
        {uploadHandler && (
          <input
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) {
                uploadHandler(file);
              }
            }}
            ref={imageInputRef}
            type="file"
          />
        )}
      </div>
    </TooltipProvider>
  );
}

type ToolbarButtonProps = {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
};

function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
}: Readonly<ToolbarButtonProps>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          className={cn("h-8 w-8 p-0 text-foreground", active && "bg-accent")}
          disabled={disabled}
          onClick={onClick}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{label}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ToolbarDivider() {
  return <div className="h-8 w-px bg-border" />;
}
