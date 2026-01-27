"use client";

import {
  codeBlockPlugin,
  codeMirrorPlugin,
  frontmatterPlugin,
  headingsPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { RichTextToolbar } from "./rich-text-toolbar";
import "./styles.css";

import type { RichTextEditorProps } from "./types";
import type { ToMarkdownOptions } from "@mdxeditor/editor";

const MARKDOWN_OPTIONS: ToMarkdownOptions = { bullet: "-" };

/**
 * Escapes content for MDXEditor display.
 * MDXEditor uses MDX which tries to parse angle brackets as JSX components.
 * Since implementation plans don't need HTML/JSX, we escape all angle brackets.
 */
function escapeForEditor(markdown: string): string {
  if (!markdown) return markdown;

  // Escape angle brackets with backslash to prevent JSX parsing
  // MDX treats \< and \> as literal characters
  return markdown
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>");
}

/**
 * Unescapes content when saving from MDXEditor.
 * Reverses the escaping done for display.
 */
function unescapeFromEditor(markdown: string): string {
  if (!markdown) return markdown;

  // Remove backslash escapes from angle brackets
  return markdown
    .replace(/\\</g, "<")
    .replace(/\\>/g, ">");
}

function ToolbarContents() {
  return <RichTextToolbar />;
}

export function RichTextEditorCore({
  value,
  onChange,
  placeholder = "Start writing...",
  readOnly = false,
}: Readonly<RichTextEditorProps>) {
  const editorRef = useRef<MDXEditorMethods>(null);

  // Escape content for display in MDXEditor
  const displayValue = useMemo(() => escapeForEditor(value ?? ""), [value]);

  // Update editor content when value changes externally (e.g., after generation completes)
  const lastSetValueRef = useRef<string>(displayValue);
  useEffect(() => {
    if (editorRef.current && displayValue !== lastSetValueRef.current) {
      lastSetValueRef.current = displayValue;
      editorRef.current.setMarkdown(displayValue);
    }
  }, [displayValue]);

  // Wrap onChange to unescape content before passing to parent
  const handleChange = useCallback(
    (newValue: string) => {
      lastSetValueRef.current = newValue; // Track what we set to avoid loops
      onChange(unescapeFromEditor(newValue));
    },
    [onChange]
  );

  // Memoize plugins to prevent recreation on each render
  const plugins = useMemo(
    () => [
      headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
      listsPlugin(),
      thematicBreakPlugin(),
      markdownShortcutPlugin(),
      quotePlugin(),
      tablePlugin(),
      frontmatterPlugin(),
      codeBlockPlugin({ defaultCodeBlockLanguage: "typescript" }),
      codeMirrorPlugin({
        codeBlockLanguages: {
          typescript: "TypeScript",
          javascript: "JavaScript",
          python: "Python",
          bash: "Bash",
          shell: "Shell",
          json: "JSON",
          yaml: "YAML",
          sql: "SQL",
          html: "HTML",
          css: "CSS",
          markdown: "Markdown",
          text: "Plain Text",
          "": "Plain Text",
        },
      }),
      toolbarPlugin({
        toolbarClassName: "rich-text-editor-toolbar",
        toolbarPosition: "bottom",
        toolbarContents: ToolbarContents,
      }),
    ],
    []
  );

  return (
    <MDXEditor
      ref={editorRef}
      className="rich-text-editor-root"
      contentEditableClassName="rich-text-editor-content"
      markdown={displayValue}
      placeholder={placeholder}
      plugins={plugins}
      readOnly={readOnly}
      spellCheck={true}
      toMarkdownOptions={MARKDOWN_OPTIONS}
      onChange={handleChange}
    />
  );
}
