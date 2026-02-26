"use client";

import { useRoom } from "@liveblocks/react";
import { useIsEditorReady, useLiveblocksExtension } from "@repo/collaboration";
import { cn } from "@repo/design-system/lib/utils";
import { RichTextEditor } from "@repo/rich-text";
import type { Editor } from "@tiptap/react";
import { useRef } from "react";

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
   * Callback to get the editor instance (for comments/collaboration features).
   * The callback is only called when liveblocks is enabled (liveblocksRoomId is not null).
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
  /**
   * Where scrolling is handled for the editor content.
   * "inner" keeps scroll inside the editor; "outer" lets a parent container scroll.
   */
  scrollMode?: "inner" | "outer";
};

export function EditorContent({
  value,
  onChange,
  liveblocksRoomId,
  onEditorReady,
  placeholder,
  readOnly,
  className,
  contentResetKey,
  contentResetValue,
  scrollMode = "inner",
}: Readonly<EditorContentProps>) {
  const shouldUseLiveblocks = !!liveblocksRoomId;

  // If no roomId, render without Liveblocks
  if (!shouldUseLiveblocks) {
    return (
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          scrollMode !== "outer" && "overflow-hidden",
          className
        )}
      >
        <RichTextEditor
          contentResetKey={contentResetKey}
          contentResetValue={contentResetValue}
          onChange={onChange}
          placeholder={placeholder}
          readOnly={readOnly}
          scrollMode={scrollMode}
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
      onChange={onChange}
      onEditorReady={onEditorReady}
      placeholder={placeholder}
      readOnly={readOnly}
      scrollMode={scrollMode}
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
>;

function EditorContentWithLiveblocks({
  value,
  onChange,
  onEditorReady,
  placeholder,
  readOnly,
  className,
  contentResetKey,
  contentResetValue,
  scrollMode = "inner",
}: Readonly<EditorContentWithLiveblocksProps>) {
  const liveblocksExtension = useLiveblocksExtension();
  const isEditorReady = useIsEditorReady();
  const room = useRoom();

  // We need a key we can use with the rich text editor below, to force a remount when
  // the room changes. I am not really sure why this is necessary, but without it, the
  // liveblocks state will not be restored correctly when opening the editor for a second
  // time. The contents will be empty in that case.
  const prevRoomRef = useRef(room);
  const editorKeyRef = useRef(0);
  if (prevRoomRef.current !== room) {
    prevRoomRef.current = room;
    editorKeyRef.current += 1;
  }

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        scrollMode !== "outer" && "overflow-hidden",
        className
      )}
    >
      <RichTextEditor
        contentResetKey={contentResetKey}
        contentResetValue={contentResetValue}
        key={editorKeyRef.current}
        liveblocksExtension={liveblocksExtension}
        liveblocksIsReady={isEditorReady}
        onChange={onChange}
        onEditorReady={onEditorReady}
        placeholder={placeholder}
        readOnly={readOnly}
        scrollMode={scrollMode}
        value={value}
      />
    </div>
  );
}
