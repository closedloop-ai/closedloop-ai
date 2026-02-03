"use client";

import type { Editor } from "@tiptap/react";
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
  Table as TableIcon,
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
  function toggleLink() {
    const previousUrl = editor?.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL", previousUrl);

    if (url === null) {
      return;
    }

    if (url === "") {
      editor?.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor?.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  function insertMermaidDiagram() {
    editor?.chain()
      .focus()
      .insertContent({
        type: "mermaid",
        attrs: {
          content: "graph TD\n    A[Start] --> B[End]",
        },
      })
      .run();
  }

  function insertTable() {
    editor?.chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  }

  if (readOnly) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="flex flex-wrap gap-1 p-2 border-b bg-muted/50">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("heading", { level: 1 }) && "bg-accent"
              )}
              disabled={readOnly}
            >
              <Heading1 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Heading 1</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("heading", { level: 2 }) && "bg-accent"
              )}
              disabled={readOnly}
            >
              <Heading2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Heading 2</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("heading", { level: 3 }) && "bg-accent"
              )}
              disabled={readOnly}
            >
              <Heading3 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Heading 3</p>
          </TooltipContent>
        </Tooltip>
        <div className="w-px h-8 bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleBold().run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("bold") && "bg-accent"
              )}
              disabled={readOnly}
            >
              <Bold className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Bold</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleItalic().run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("italic") && "bg-accent"
              )}
              disabled={readOnly}
            >
              <Italic className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Italic</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleCode().run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("code") && "bg-accent"
              )}
              disabled={readOnly}
            >
              <Code className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Inline Code</p>
          </TooltipContent>
        </Tooltip>
        <div className="w-px h-8 bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("bulletList") && "bg-accent"
              )}
              disabled={readOnly}
            >
              <List className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Bullet List</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("orderedList") && "bg-accent"
              )}
              disabled={readOnly}
            >
              <ListOrdered className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Numbered List</p>
          </TooltipContent>
        </Tooltip>
        <div className="w-px h-8 bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("blockquote") && "bg-accent"
              )}
              disabled={readOnly}
            >
              <Quote className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Blockquote</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={toggleLink}
              className={cn(
                "h-8 w-8 p-0",
                editor?.isActive("link") && "bg-accent"
              )}
              disabled={readOnly}
            >
              <LinkIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Link</p>
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={insertTable}
              className="h-8 w-8 p-0"
              disabled={readOnly}
            >
              <TableIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Insert Table</p>
          </TooltipContent>
        </Tooltip>
        <div className="w-px h-8 bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={insertMermaidDiagram}
              className="h-8 w-8 p-0"
              disabled={readOnly}
            >
              <Network className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Insert Mermaid Diagram</p>
          </TooltipContent>
        </Tooltip>
        <div className="w-px h-8 bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onPasteMarkdown}
              className="h-8 w-8 p-0"
              disabled={readOnly}
            >
              <FileText className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Paste Markdown</p>
          </TooltipContent>
        </Tooltip>
        {hasLiveblocksExtension && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  // @ts-ignore - addPendingComment is added by Liveblocks extension
                  editor?.chain().focus().addPendingComment().run();
                }}
                className="h-8 w-8 p-0"
                disabled={readOnly}
              >
                <MessageSquarePlus className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Add Comment</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}
