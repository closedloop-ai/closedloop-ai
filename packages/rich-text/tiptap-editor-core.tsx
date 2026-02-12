"use client";

import "./tiptap-editor.css";

import { cn } from "@repo/design-system/lib/utils";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { MermaidExtension } from "./mermaid-extension";
import { TiptapPasteMarkdownDialog } from "./tiptap-paste-markdown-dialog";
import { TiptapToolbar } from "./tiptap-toolbar";
import type { RichTextEditorProps } from "./types";

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
  scrollMode = "inner",
}: Readonly<RichTextEditorProps>) {
  const [showPasteMarkdownDialog, setShowPasteMarkdownDialog] = useState(false);
  const hasSeededContent = useRef(false);
  // Capture initial content on first render to avoid it being cleared by onChange
  const initialContentRef = useRef(value);
  const isOuterScroll = scrollMode === "outer";

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
      Markdown,
      MermaidExtension,
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      ...(liveblocksExtension ? [liveblocksExtension] : []),
    ],
    // When using Liveblocks, don't set initial content here
    // The Liveblocks extension will handle syncing
    ...(!liveblocksExtension && { content: value, contentType: "markdown" }),
    editable: !readOnly,
    // Prevent SSR hydration mismatches
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn(
          "prose prose-sm sm:prose-base dark:prose-invert min-h-[200px] max-w-none p-4 focus:outline-none",
          className
        ),
      },
    },
    onCreate: ({ editor }) => {
      onEditorReady?.(editor);
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getMarkdown());
    },
  });

  const setMarkdownContent = useCallback(
    (markdown: string) => {
      if (editor) {
        // Defer to microtask to avoid flushSync inside React lifecycle
        queueMicrotask(() => {
          editor.commands.setContent(markdown, { contentType: "markdown" });
        });
      }
    },
    [editor]
  );

  // Sync content when not using Liveblocks.
  useEffect(() => {
    if (!editor) {
      return;
    }
    if (liveblocksExtension) {
      return;
    }

    if (value !== editor.getMarkdown()) {
      setMarkdownContent(value);
    }
  }, [editor, liveblocksExtension, setMarkdownContent, value]);

  // Seed Liveblocks with initial content if the document is empty once liveblocks has synced.
  useEffect(() => {
    const initialContent = initialContentRef.current;

    if (
      !(editor && liveblocksExtension && liveblocksIsReady && initialContent) ||
      hasSeededContent.current
    ) {
      return;
    }

    // Check if editor is empty after Liveblocks sync is complete
    const currentText = editor.getText().trim();

    if (currentText === "" && initialContent.trim() !== "") {
      // Seed the Liveblocks document with the initial markdown content
      setMarkdownContent(initialContent);
      hasSeededContent.current = true;
    }
  }, [editor, liveblocksExtension, liveblocksIsReady, setMarkdownContent]);

  // Explicit content reset (e.g. restore a version).
  // Temporarily ensures the editor is editable so the command succeeds
  // even when readOnly flips to true in the same render batch.
  useEffect(() => {
    if (editor && contentResetKey && contentResetValue != null) {
      const markdown = contentResetValue;
      queueMicrotask(() => {
        const wasEditable = editor.isEditable;
        if (!wasEditable) {
          editor.setEditable(true);
        }
        editor.commands.setContent(markdown, { contentType: "markdown" });
        if (!wasEditable) {
          editor.setEditable(false);
        }
      });
    }
  }, [editor, contentResetKey, contentResetValue]);

  // Update editable state when readOnly changes
  useEffect(() => {
    if (editor) {
      editor.setEditable(!readOnly);
    }
  }, [editor, readOnly]);

  return (
    <>
      <div
        className="flex min-h-0 flex-1 flex-col rounded-md border"
        data-liveblocks-editor-boundary
      >
        {!readOnly && (
          <TiptapToolbar
            editor={editor}
            hasLiveblocksExtension={!!liveblocksExtension}
            onPasteMarkdown={() => setShowPasteMarkdownDialog(true)}
            readOnly={readOnly}
          />
        )}
        <div
          className={cn("min-h-0", !isOuterScroll && "flex-1 overflow-y-auto")}
        >
          <EditorContent
            className={cn("min-h-[200px]", readOnly && "p-4")}
            editor={editor}
          />
        </div>
      </div>

      {!readOnly && (
        <TiptapPasteMarkdownDialog
          onOpenChange={setShowPasteMarkdownDialog}
          onSetContent={setMarkdownContent}
          open={showPasteMarkdownDialog}
        />
      )}
    </>
  );
}
