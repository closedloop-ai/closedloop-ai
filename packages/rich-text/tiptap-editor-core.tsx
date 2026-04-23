"use client";

import "./tiptap-editor.css";

import { cn } from "@repo/design-system/lib/utils";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { TableRow } from "@tiptap/extension-table-row";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useCallback, useEffect, useRef } from "react";
import { MermaidExtension } from "./mermaid-extension";
import { RichTextToolbar } from "./rich-text-toolbar";
import { setEditorMarkdown } from "./set-editor-markdown";
import type { RichTextEditorProps, TiptapEditor } from "./types";

export function TiptapEditorCore({
  value,
  placeholder,
  onChange,
  onEditorReady,
  readOnly = false,
  className,
  liveblocksExtension,
  liveblocksIsReady,
  scrollMode = "inner",
  externalToolbar = false,
  toolbarMode = "always",
}: Readonly<RichTextEditorProps>) {
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
        // Disable built-in history when Liveblocks provides its own undo/redo via Yjs
        ...(liveblocksExtension && { undoRedo: false }),
      }),
      Markdown.configure({
        markedOptions: {
          // Claude Code uses GitHub Flavored Markdown
          gfm: true,
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
      MermaidExtension,
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem,
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
          "prose prose-sm sm:prose-base dark:prose-invert min-h-[200px] max-w-none px-5 pt-8 pb-8 focus:outline-none",
          className
        ),
      },
    },
    onCreate: ({ editor }) => {
      const editorWithReset = editor as TiptapEditor;
      editorWithReset.resetContent = (markdown: string) =>
        setEditorMarkdown(editor, markdown);
      onEditorReady?.(editorWithReset);
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getMarkdown());
    },
  });

  const setMarkdownContent = useCallback(
    (markdown: string) => {
      setEditorMarkdown(editor, markdown);
    },
    [editor]
  );

  useEffect(
    function trackReadOnlyChanges() {
      if (editor) {
        editor.setEditable(!readOnly);
      }
    },
    [editor, readOnly]
  );

  // Sync content when not using Liveblocks.
  useEffect(
    function trackValueChanges() {
      if (!editor || liveblocksExtension) {
        return;
      }
      if (value !== editor.getMarkdown()) {
        setMarkdownContent(value);
      }
    },
    [editor, liveblocksExtension, setMarkdownContent, value]
  );

  useEffect(
    function maybeSeedLiveblocksRoom() {
      const initialContent = initialContentRef.current;

      if (
        !(
          editor &&
          liveblocksExtension &&
          liveblocksIsReady &&
          initialContent
        ) ||
        hasSeededContent.current
      ) {
        return;
      }

      if (!editor.getText().trim()) {
        // The passed in value has content, and the liveblocks room is empty.
        // Seed the liveblocks room with the initial content.
        setMarkdownContent(initialContent);
      }

      hasSeededContent.current = true;
    },
    [editor, liveblocksExtension, liveblocksIsReady, setMarkdownContent]
  );

  return (
    <div
      className="group flex min-h-0 flex-1 flex-col"
      data-liveblocks-editor-boundary
    >
      {!(readOnly || externalToolbar) && (
        <div
          className={
            toolbarMode === "focus"
              ? "hidden group-focus-within:block"
              : undefined
          }
        >
          <RichTextToolbar
            editor={editor}
            hasLiveblocksExtension={!!liveblocksExtension}
            onPasteMarkdown={setMarkdownContent}
            readOnly={readOnly}
          />
        </div>
      )}
      <div
        className={cn("min-h-0", !isOuterScroll && "flex-1 overflow-y-auto")}
      >
        <EditorContent className="min-h-[200px]" editor={editor} />
      </div>
    </div>
  );
}
