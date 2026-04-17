import type { AnyExtension, Editor } from "@tiptap/react";

export type TiptapEditor = Editor & {
  /**
   * Reset the editor content from a markdown string.
   * Temporarily makes the editor editable if it's read-only,
   * so the command succeeds even in view mode.
   */
  resetContent: (markdown: string) => void;
};

export type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onEditorReady?: (editor: TiptapEditor | null) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  liveblocksExtension?: AnyExtension;
  /**
   * Whether the Liveblocks editor has finished syncing and is ready.
   * Only used when liveblocksExtension is provided.
   * When true, indicates that Yjs sync is complete.
   */
  liveblocksIsReady?: boolean;
  /**
   * Where scrolling is handled for the editor content.
   * "inner" keeps scroll inside the editor; "outer" lets a parent container scroll.
   */
  scrollMode?: "inner" | "outer";
  /**
   * When true, the formatting toolbar is not rendered inline.
   * Use with the exported TiptapToolbar to render the toolbar elsewhere.
   */
  externalToolbar?: boolean;
  /**
   * Controls toolbar visibility.
   * "always" (default) shows the toolbar whenever the editor is not read-only.
   * "focus" hides the toolbar until the editor receives focus.
   */
  toolbarMode?: "always" | "focus";
};
