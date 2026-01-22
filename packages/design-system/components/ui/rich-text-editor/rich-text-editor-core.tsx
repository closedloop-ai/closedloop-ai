"use client";

import {
  headingsPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { memo, useCallback, useMemo, useRef } from "react";

import { cn } from "@repo/design-system/lib/utils";

import { RichTextToolbar } from "./rich-text-toolbar";
import "./styles.css";

import type { RichTextEditorProps } from "./types";
import type { MDXEditorMethods, RealmPlugin, ToMarkdownOptions } from "@mdxeditor/editor";

const MDX_ROOT_CLASS = "rich-text-editor-root";
const MDX_CONTENT_CLASS = "rich-text-editor-content";
const MDX_TOOLBAR_CLASS = "rich-text-editor-toolbar";

export const RichTextEditorCore = memo(function RichTextEditorCore({
  value,
  onChange,
  placeholder = "Start writing...",
  className,
  readOnly = false,
}: Readonly<RichTextEditorProps>) {
  const editorRef = useRef<MDXEditorMethods | null>(null);

  const ToolbarContents = useCallback(() => <RichTextToolbar />, []);

  const plugins = useMemo<RealmPlugin[]>(
    () => [
      headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
      listsPlugin(),
      thematicBreakPlugin(),
      markdownShortcutPlugin(),
      quotePlugin(),
      toolbarPlugin({
        toolbarClassName: MDX_TOOLBAR_CLASS,
        toolbarPosition: "bottom",
        toolbarContents: ToolbarContents,
      }),
    ],
    [ToolbarContents]
  );

  const markdownOptions: ToMarkdownOptions = useMemo(
    () => ({
      bullet: "-",
    }),
    []
  );

  const handleChange = useCallback(
    (newMarkdown: string) => {
      onChange(newMarkdown);
    },
    [onChange]
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <MDXEditor
        ref={editorRef}
        className={MDX_ROOT_CLASS}
        contentEditableClassName={MDX_CONTENT_CLASS}
        markdown={value}
        placeholder={placeholder}
        plugins={plugins}
        readOnly={readOnly}
        spellCheck={true}
        toMarkdownOptions={markdownOptions}
        onChange={handleChange}
      />
    </div>
  );
});
