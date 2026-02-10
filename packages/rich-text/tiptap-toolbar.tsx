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
import { useCallback, useEffect, useState } from "react";

type TiptapToolbarProps = {
  editor: Editor | null;
  readOnly?: boolean;
  hasLiveblocksExtension?: boolean;
  onPasteMarkdown: () => void;
};

export function TiptapToolbar({
  editor,
  readOnly = false,
  hasLiveblocksExtension = false,
  onPasteMarkdown,
}: Readonly<TiptapToolbarProps>) {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const updateHistoryState = useCallback(() => {
    if (editor) {
      setCanUndo(editor.can().undo());
      setCanRedo(editor.can().redo());
    }
  }, [editor]);

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

    if (url === "") {
      editor?.chain().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor?.chain().extendMarkRange("link").setLink({ href: url }).run();
  }

  return (
    <TooltipProvider>
      <div className="flex flex-wrap gap-1 border-b bg-muted/50 p-2">
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
          active={editor?.isActive("heading", { level: 1 })}
          disabled={readOnly}
          icon={Heading1}
          label="Heading 1"
          onClick={() => editor?.commands.toggleHeading({ level: 1 })}
        />
        <ToolbarButton
          active={editor?.isActive("heading", { level: 2 })}
          disabled={readOnly}
          icon={Heading2}
          label="Heading 2"
          onClick={() => editor?.commands.toggleHeading({ level: 2 })}
        />
        <ToolbarButton
          active={editor?.isActive("heading", { level: 3 })}
          disabled={readOnly}
          icon={Heading3}
          label="Heading 3"
          onClick={() => editor?.commands.toggleHeading({ level: 3 })}
        />
        <ToolbarDivider />
        <ToolbarButton
          active={editor?.isActive("bold")}
          disabled={readOnly}
          icon={Bold}
          label="Bold"
          onClick={() => editor?.commands.toggleBold()}
        />
        <ToolbarButton
          active={editor?.isActive("italic")}
          disabled={readOnly}
          icon={Italic}
          label="Italic"
          onClick={() => editor?.commands.toggleItalic()}
        />
        <ToolbarButton
          active={editor?.isActive("code")}
          disabled={readOnly}
          icon={Code}
          label="Inline Code"
          onClick={() => editor?.commands.toggleCode()}
        />
        <ToolbarDivider />
        <ToolbarButton
          active={editor?.isActive("bulletList")}
          disabled={readOnly}
          icon={List}
          label="Bullet List"
          onClick={() => editor?.commands.toggleBulletList()}
        />
        <ToolbarButton
          active={editor?.isActive("orderedList")}
          disabled={readOnly}
          icon={ListOrdered}
          label="Numbered List"
          onClick={() => editor?.commands.toggleOrderedList()}
        />
        <ToolbarDivider />
        <ToolbarButton
          active={editor?.isActive("blockquote")}
          disabled={readOnly}
          icon={Quote}
          label="Blockquote"
          onClick={() => editor?.commands.toggleBlockquote()}
        />
        <ToolbarButton
          active={editor?.isActive("link")}
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
        <ToolbarDivider />
        <ToolbarButton
          disabled={readOnly}
          icon={FileText}
          label="Paste Markdown"
          onClick={onPasteMarkdown}
        />
        {hasLiveblocksExtension && (
          <ToolbarButton
            disabled={readOnly}
            icon={MessageSquarePlus}
            label="Add Comment"
            onClick={() => {
              // addPendingComment is added by the Liveblocks extension at runtime
              (
                editor?.commands as unknown as { addPendingComment: () => void }
              ).addPendingComment();
            }}
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
          className={cn("h-8 w-8 p-0", active && "bg-accent")}
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
