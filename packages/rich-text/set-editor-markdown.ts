import type { Editor } from "@tiptap/react";

/**
 * Sets the editor content from a markdown string.
 * Defers to a microtask to avoid flushSync issues inside React lifecycle.
 */
export function setEditorMarkdown(editor: Editor | null, markdown: string) {
  if (editor) {
    queueMicrotask(() => {
      editor.commands.setContent(markdown, { contentType: "markdown" });
    });
  }
}
