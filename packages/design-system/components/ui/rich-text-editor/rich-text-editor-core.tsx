"use client";

import {
  headingsPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

import { RichTextToolbar } from "./rich-text-toolbar";
import "./styles.css";

import type { RichTextEditorProps } from "./types";
import type { ToMarkdownOptions } from "@mdxeditor/editor";

const MARKDOWN_OPTIONS: ToMarkdownOptions = { bullet: "-" };

function ToolbarContents() {
  return <RichTextToolbar />;
}

const plugins = [
  headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
  listsPlugin(),
  thematicBreakPlugin(),
  markdownShortcutPlugin(),
  quotePlugin(),
  tablePlugin(),
  toolbarPlugin({
    toolbarClassName: "rich-text-editor-toolbar",
    toolbarPosition: "bottom",
    toolbarContents: ToolbarContents,
  }),
];

export function RichTextEditorCore({
  value,
  onChange,
  placeholder = "Start writing...",
  readOnly = false,
}: Readonly<RichTextEditorProps>) {
  return (
    <MDXEditor
      className="rich-text-editor-root"
      contentEditableClassName="rich-text-editor-content"
      markdown={value}
      placeholder={placeholder}
      plugins={plugins}
      readOnly={readOnly}
      spellCheck={true}
      toMarkdownOptions={MARKDOWN_OPTIONS}
      onChange={onChange}
    />
  );
}
