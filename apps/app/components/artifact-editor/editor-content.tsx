"use client";

import { useIsEditorReady, useLiveblocksExtension } from "@repo/collaboration";
import { RichTextEditor } from "@repo/design-system/components/ui/rich-text-editor";
import { cn } from "@repo/design-system/lib/utils";
import type { Editor } from "@tiptap/react";

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
   * Optional Liveblocks room ID for collaborative editing
   */
  liveblocksRoomId?: string | null;
  /**
   * Whether to enable Liveblocks for this editor instance
   */
  enableLiveblocks?: boolean;
  /**
   * Callback to get the editor instance (for comments/collaboration features)
   */
  onEditorReady?: (editor: Editor | null) => void;
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
  /**
   * Forces a content reset when Liveblocks is active
   */
  contentResetKey?: number;
  /**
   * Content to apply when a reset is triggered
   */
  contentResetValue?: string;
};

export function EditorContent({
  value,
  onChange,
  liveblocksRoomId,
  enableLiveblocks = true,
  onEditorReady,
  placeholder,
  readOnly,
  className,
  contentResetKey,
  contentResetValue,
}: Readonly<EditorContentProps>) {
  const shouldUseLiveblocks = !!liveblocksRoomId && enableLiveblocks;
  const editorKey = shouldUseLiveblocks
    ? `liveblocks-${liveblocksRoomId ?? "room"}`
    : "static";

  // If no roomId, render without Liveblocks
  if (!shouldUseLiveblocks) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden",
          className
        )}
      >
        <RichTextEditor
          contentResetKey={contentResetKey}
          contentResetValue={contentResetValue}
          key={editorKey}
          onChange={onChange}
          onEditorReady={onEditorReady}
          placeholder={placeholder}
          readOnly={readOnly}
          value={value}
        />
      </div>
    );
  }

  // Has roomId, render with Liveblocks
  return (
    <EditorContentWithLiveblocks
      className={className}
      contentResetKey={contentResetKey}
      contentResetValue={contentResetValue}
      editorKey={editorKey}
      onChange={onChange}
      onEditorReady={onEditorReady}
      placeholder={placeholder}
      readOnly={readOnly}
      value={value}
    />
  );
}

/**
 * Internal component that uses Liveblocks hooks.
 * Only rendered when roomId exists and we're inside RoomProvider.
 */
type EditorContentWithLiveblocksProps = Omit<
  EditorContentProps,
  "liveblocksRoomId" | "enableLiveblocks"
> & {
  editorKey: string;
};

function EditorContentWithLiveblocks({
  value,
  onChange,
  onEditorReady,
  placeholder,
  readOnly,
  className,
  contentResetKey,
  contentResetValue,
  editorKey,
}: EditorContentWithLiveblocksProps) {
  const liveblocksExtension = useLiveblocksExtension();
  const isEditorReady = useIsEditorReady();

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}
    >
      <RichTextEditor
        contentResetKey={contentResetKey}
        contentResetValue={contentResetValue}
        key={editorKey}
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady={isEditorReady}
        onChange={onChange}
        onEditorReady={onEditorReady}
        placeholder={placeholder}
        readOnly={readOnly}
        value={value}
      />
    </div>
  );
}
