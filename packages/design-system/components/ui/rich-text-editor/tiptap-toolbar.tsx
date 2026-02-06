"use client";

import { useCallback, useEffect, useState } from "react";
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
import { Button } from "@repo/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";

interface TiptapToolbarProps {
  editor: Editor | null;
  readOnly?: boolean;
  hasLiveblocksExtension?: boolean;
  onPasteMarkdown: () => void;
}

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
    if (!editor) return;
    updateHistoryState();
    editor.on("transaction", updateHistoryState);
    return () => {
      editor.off("transaction", updateHistoryState);
    };
  }, [editor, updateHistoryState]);

  function toggleLink() {
    const previousUrl = editor?.getAttributes("link").href as string | undefined;
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
      <div className="flex flex-wrap gap-1 p-2 border-b bg-muted/50">
        <ToolbarButton 
          icon={Undo}  
          label="Undo" 
          onClick={() => editor?.commands.undo()} 
          disabled={readOnly || !canUndo} />
        <ToolbarButton 
          icon={Redo} 
          label="Redo" 
          onClick={() => editor?.commands.redo()} 
          disabled={readOnly || !canRedo} />
        <ToolbarDivider />
        <ToolbarButton
          icon={Heading1}
          label="Heading 1"
          onClick={() => editor?.commands.toggleHeading({ level: 1 })}
          active={editor?.isActive("heading", { level: 1 })}
          disabled={readOnly}
        />
        <ToolbarButton
          icon={Heading2}
          label="Heading 2"
          onClick={() => editor?.commands.toggleHeading({ level: 2 })}
          active={editor?.isActive("heading", { level: 2 })}
          disabled={readOnly}
        />
        <ToolbarButton
          icon={Heading3}
          label="Heading 3"
          onClick={() => editor?.commands.toggleHeading({ level: 3 })}
          active={editor?.isActive("heading", { level: 3 })}
          disabled={readOnly}
        />
        <ToolbarDivider />
        <ToolbarButton
          icon={Bold}
          label="Bold"
          onClick={() => editor?.commands.toggleBold()}
          active={editor?.isActive("bold")}
          disabled={readOnly}
        />
        <ToolbarButton
          icon={Italic}
          label="Italic"
          onClick={() => editor?.commands.toggleItalic()}
          active={editor?.isActive("italic")}
          disabled={readOnly}
        />
        <ToolbarButton
          icon={Code}
          label="Inline Code"
          onClick={() => editor?.commands.toggleCode()}
          active={editor?.isActive("code")}
          disabled={readOnly}
        />
        <ToolbarDivider />
        <ToolbarButton
          icon={List}
          label="Bullet List"
          onClick={() => editor?.commands.toggleBulletList()}
          active={editor?.isActive("bulletList")}
          disabled={readOnly}
        />
        <ToolbarButton
          icon={ListOrdered}
          label="Numbered List"
          onClick={() => editor?.commands.toggleOrderedList()}
          active={editor?.isActive("orderedList")}
          disabled={readOnly}
        />
        <ToolbarDivider />
        <ToolbarButton
          icon={Quote}
          label="Blockquote"
          onClick={() => editor?.commands.toggleBlockquote()}
          active={editor?.isActive("blockquote")}
          disabled={readOnly}
        />
        <ToolbarButton
          icon={LinkIcon}
          label="Link"
          onClick={toggleLink}
          active={editor?.isActive("link")}
          disabled={readOnly}
        />
        <ToolbarButton
          icon={TableIcon}
          label="Insert Table"
          onClick={() =>
            editor
              ?.commands
              .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          }
          disabled={readOnly}
        />
        <ToolbarDivider />
        <ToolbarButton
          icon={Network}
          label="Insert Mermaid Diagram"
          onClick={() =>
            editor
              ?.commands
              .insertContent({
                type: "mermaid",
                attrs: { content: "graph TD\n    A[Start] --> B[End]" }
              })
          }
          disabled={readOnly}
        />
        <ToolbarDivider />
        <ToolbarButton
          icon={FileText}
          label="Paste Markdown"
          onClick={onPasteMarkdown}
          disabled={readOnly}
        />
        {hasLiveblocksExtension && (
          <ToolbarButton
            icon={MessageSquarePlus}
            label="Add Comment"
            onClick={() => {
              // @ts-ignore - addPendingComment is added by Liveblocks extension
              editor?.commands.addPendingComment();
            }}
            disabled={readOnly}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

interface ToolbarButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}

function ToolbarButton({ icon: Icon, label, onClick, active, disabled }: Readonly<ToolbarButtonProps>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClick}
          className={cn("h-8 w-8 p-0", active && "bg-accent")}
          disabled={disabled}
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
  return <div className="w-px h-8 bg-border" />;
}
