"use client";

import "./tiptap-editor.css";
import type { Editor } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableCell } from "@tiptap/extension-table-cell";
import { MermaidExtension } from "./mermaid-extension";
import { mermaidMarkdownConfig } from "./markdown-mermaid-config";
import { cn } from "@repo/design-system/lib/utils";
import type { RichTextEditorProps } from "./types";
import { TiptapToolbar } from "./tiptap-toolbar";
import { TiptapPasteMarkdownDialog } from "./tiptap-paste-markdown-dialog";

export function TiptapEditorCore({
  value,
  onChange,
  onEditorReady,
  readOnly = false,
  className,
  contentResetKey,
  contentResetValue,
  liveblocksExtension,
  liveblocksIsReady,
}: Readonly<RichTextEditorProps>) {
  const [showPasteMarkdownDialog, setShowPasteMarkdownDialog] = useState(false);
  const hasSeededContent = useRef(false);
  // Capture initial content on first render to avoid it being cleared by onChange
  const initialContentRef = useRef(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Configure heading levels to match markdown
        heading: {
          levels: [1, 2, 3],
        },
        // Keep the default codeBlock for non-mermaid code
        codeBlock: {
          languageClassPrefix: "language-",
        },
        undoRedo: false,
      }),
      MermaidExtension,
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({
        html: true, // Don't allow HTML in markdown
        transformPastedText: true, // Enable transformation to handle mermaid blocks
        transformCopiedText: false,
        ...mermaidMarkdownConfig,
      }),
      ...(liveblocksExtension ? [liveblocksExtension] : []),
    ],
    // When using Liveblocks, don't set initial content here
    // The Liveblocks extension will handle syncing
    content: liveblocksExtension ? "" : value,
    editable: !readOnly,
    // Prevent SSR hydration mismatches
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm sm:prose-base dark:prose-invert max-w-none focus:outline-none min-h-[200px] p-4",
          className
        ),
      },
    },
    onCreate: ({ editor }) => {
      onEditorReady?.(editor);
    },
    onDestroy: () => {
      onEditorReady?.(null);
    },
    onUpdate: ({ editor }) => {
      const markdown = getMarkdownStorage(editor).getMarkdown();
      onChange(markdown);
    },
  });

  // Sync content when not using Liveblocks.
  useEffect(() => {
    if (!editor) {
      return;
    }
    if (liveblocksExtension) {
      return;
    }

    const currentMarkdown = getMarkdownStorage(editor).getMarkdown();
    if (value !== currentMarkdown) {
      editor.commands.setContent(value);
    }
  }, [editor, liveblocksExtension, value]);

  // Seed Liveblocks with initial content if the document is empty once liveblocks has synced.
  useEffect(() => {
    const initialContent = initialContentRef.current;

    if (
      !editor ||
      !liveblocksExtension ||
      !liveblocksIsReady ||
      !initialContent ||
      hasSeededContent.current
    ) {
      return;
    }

    // Check if editor is empty after Liveblocks sync is complete
    const currentText = editor.getText().trim();

    if (currentText === "" && initialContent.trim() !== "") {
      // Seed the Liveblocks document with the initial markdown content
      editor.commands.setContent(initialContent);
      hasSeededContent.current = true;
    }
  }, [editor, liveblocksExtension, liveblocksIsReady]);

  // Explicit content reset (e.g. restore a version)
  useEffect(() => {
    if (editor && contentResetKey && contentResetValue) {
      editor.commands.setContent(contentResetValue);
    }
  }, [editor, contentResetKey, contentResetValue]);

  // Update editable state when readOnly changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [editor, readOnly]);

  function handleSetMarkdownContent(markdown: string) {
    if (markdown && editor) {
      editor.commands.setContent(markdown);
    }
  }

  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col border rounded-md"
        data-liveblocks-editor-boundary
      >
        <TiptapToolbar
          editor={editor}
          readOnly={readOnly}
          hasLiveblocksExtension={!!liveblocksExtension}
          onPasteMarkdown={() => setShowPasteMarkdownDialog(true)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EditorContent
            editor={editor}
            className={cn("min-h-[200px]", readOnly && "p-4")}
          />
        </div>
      </div>

      <TiptapPasteMarkdownDialog
        open={showPasteMarkdownDialog}
        onOpenChange={setShowPasteMarkdownDialog}
        onSetContent={handleSetMarkdownContent}
      />
    </>
  );
}

// Type for the markdown extension storage added by tiptap-markdown
type MarkdownStorage = {
  getMarkdown: () => string;
  serializer: unknown;
  parser: unknown;
  options: Record<string, unknown>;
};

// Helper to safely access markdown storage
function getMarkdownStorage(editor: Editor): MarkdownStorage {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown;
}
