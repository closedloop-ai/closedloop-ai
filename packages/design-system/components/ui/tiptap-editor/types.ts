import type { AnyExtension, Editor } from "@tiptap/react";

export type TiptapEditorProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
  liveblocksExtension?: AnyExtension;
  onEditorReady?: (editor: Editor | null) => void;
  contentResetKey?: number;
  contentResetValue?: string;
};
