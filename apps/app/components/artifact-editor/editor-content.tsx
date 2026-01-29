"use client";

import { RichTextEditor } from "@repo/design-system/components/ui/rich-text-editor/rich-text-editor";
import { cn } from "@repo/design-system/lib/utils";

type EditorContentProps = {
  /**
   * Current content value (markdown string)
   */
  value: string;
  /**
   * Change handler for content updates
   */
  onChange: (value: string) => void;
  /**
   * Placeholder text when editor is empty
   */
  placeholder?: string;
  /**
   * Whether the editor is read-only
   */
  readOnly?: boolean;
  /**
   * Optional className for custom styling
   */
  className?: string;
};

export function EditorContent({
  value,
  onChange,
  placeholder,
  readOnly,
  className,
}: Readonly<EditorContentProps>) {
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
    >
      <RichTextEditor
        onChange={onChange}
        placeholder={placeholder}
        readOnly={readOnly}
        value={value}
      />
    </div>
  );
}
