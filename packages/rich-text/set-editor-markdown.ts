import type { Editor } from "@tiptap/react";

/**
 * Sets the editor content from a markdown string.
 * Defers to a microtask to avoid flushSync issues inside React lifecycle.
 */
export function setEditorMarkdown(editor: Editor | null, markdown: string) {
  if (editor) {
    queueMicrotask(() => {
      // The editor can unmount between the null-guard above and this microtask
      // flush (StrictMode double-mount, key-bump remount, rapid navigation) —
      // guard against the destroyed ProseMirror view before dispatching.
      if (!editor.isDestroyed) {
        editor.commands.setContent(markdown, { contentType: "markdown" });
      }
    });
  }
}
