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
};
