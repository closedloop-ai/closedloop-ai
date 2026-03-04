import type { AnyExtension, Editor } from "@tiptap/react";

export type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onEditorReady?: (editor: Editor | null) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  contentResetKey?: number;
  contentResetValue?: string;
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
};
