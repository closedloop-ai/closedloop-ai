"use client";

import "./tiptap-editor.css";

import { cn } from "@repo/design-system/lib/utils";
import { EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useRef } from "react";
import { synchronizeEditorDomSelection } from "./editor-dom-selection";
import { createEditorExtensions } from "./editor-extensions";
import { InlineImageResolverContext } from "./inline-image-extension";
import {
  getInlineImageFilesFromTransfer,
  type InlineImageUploadPlaceholder,
  insertInlineImageFileForEditor,
} from "./inline-image-upload";
import {
  findInlineImagePlaceholderPosition,
  inlineImageUploadPlaceholderKey,
} from "./inline-image-upload-placeholder";
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
  skipEmptyRoomSeed = false,
  scrollMode = "inner",
  externalToolbar = false,
  toolbarMode = "always",
  inlineImagesEnabled = false,
  uploadInlineImage,
  resolveInlineImages,
  validateInlineImageFile,
  onInlineImageUploadError,
}: Readonly<RichTextEditorProps>) {
  const hasSeededContent = useRef(false);
  // Capture initial content on first render to avoid it being cleared by onChange
  const initialContentRef = useRef(value);
  const editorRef = useRef<TiptapEditor | null>(null);
  const isOuterScroll = scrollMode === "outer";

  const removeInlineImagePlaceholder = useCallback((uploadId: string) => {
    const activeEditor = editorRef.current;
    if (!activeEditor) {
      return;
    }
    activeEditor.view.dispatch(
      activeEditor.state.tr.setMeta(inlineImageUploadPlaceholderKey, {
        type: "remove",
        id: uploadId,
      })
    );
  }, []);

  const addInlineImagePlaceholder = useCallback(
    ({ id, pos, label }: InlineImageUploadPlaceholder) => {
      const activeEditor = editorRef.current;
      if (!activeEditor) {
        return;
      }
      activeEditor.view.dispatch(
        activeEditor.state.tr.setMeta(inlineImageUploadPlaceholderKey, {
          type: "add",
          id,
          pos,
          label,
        })
      );
    },
    []
  );

  const insertInlineImageFile = useCallback(
    async (file: File) => {
      await insertInlineImageFileForEditor({
        addInlineImagePlaceholder,
        editor: editorRef.current,
        file,
        findPlaceholderPosition: findInlineImagePlaceholderPosition,
        inlineImagesEnabled,
        onInlineImageUploadError,
        removeInlineImagePlaceholder,
        uploadInlineImage,
        validateInlineImageFile,
      });
    },
    [
      addInlineImagePlaceholder,
      inlineImagesEnabled,
      onInlineImageUploadError,
      removeInlineImagePlaceholder,
      uploadInlineImage,
      validateInlineImageFile,
    ]
  );

  const editor = useEditor({
    extensions: createEditorExtensions({ placeholder, liveblocksExtension }),
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
      handleKeyDown: synchronizeEditorDomSelection,
      handleDOMEvents: {
        drop: (_view, event) => {
          const files = Array.from(event.dataTransfer?.files ?? []);
          if (!(inlineImagesEnabled && uploadInlineImage && files.length > 0)) {
            return false;
          }
          const imageFiles = getInlineImageFilesFromTransfer(files);
          if (imageFiles.length === 0) {
            return false;
          }
          event.preventDefault();
          for (const file of imageFiles) {
            insertInlineImageFile(file).catch(() => undefined);
          }
          return true;
        },
        paste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files ?? []);
          if (!(inlineImagesEnabled && uploadInlineImage && files.length > 0)) {
            return false;
          }
          const imageFiles = getInlineImageFilesFromTransfer(files);
          if (imageFiles.length === 0) {
            return false;
          }
          event.preventDefault();
          for (const file of imageFiles) {
            insertInlineImageFile(file).catch(() => undefined);
          }
          return true;
        },
      },
    },
    onCreate: ({ editor }) => {
      const editorWithReset = editor as TiptapEditor;
      editorWithReset.resetContent = (markdown: string) =>
        setEditorMarkdown(editor, markdown);
      if (inlineImagesEnabled && uploadInlineImage) {
        editorWithReset.insertInlineImageFile = insertInlineImageFile;
      }
      editorRef.current = editorWithReset;
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
    function trackEditorRef() {
      const typedEditor = editor as TiptapEditor | null;
      if (typedEditor) {
        typedEditor.insertInlineImageFile =
          inlineImagesEnabled && uploadInlineImage
            ? insertInlineImageFile
            : undefined;
      }
      editorRef.current = typedEditor;
      editor?.view.dispatch(editor.state.tr.setMeta("inlineImageUpload", true));
      return () => {
        if (editorRef.current === editor) {
          editorRef.current = null;
        }
      };
    },
    [editor, inlineImagesEnabled, insertInlineImageFile, uploadInlineImage]
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
        skipEmptyRoomSeed ||
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
    [
      editor,
      liveblocksExtension,
      liveblocksIsReady,
      setMarkdownContent,
      skipEmptyRoomSeed,
    ]
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
        <InlineImageResolverContext.Provider value={resolveInlineImages}>
          <EditorContent className="min-h-[200px]" editor={editor} />
        </InlineImageResolverContext.Provider>
      </div>
    </div>
  );
}
