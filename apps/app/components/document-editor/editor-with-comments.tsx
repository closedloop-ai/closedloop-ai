"use client";

import { OptionalComments } from "@repo/collaboration";
import { cn } from "@repo/design-system/lib/utils";
import type { TiptapEditor } from "@repo/rich-text";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import { Suspense, useState } from "react";
import { EditorContent } from "@/components/document-editor/editor-content";

export type EditorWithCommentsProps = {
  value: string;
  onChange: (value: string) => void;
  /**
   * When true, the formatting toolbar is not rendered inside this component.
   * The parent is responsible for rendering TiptapToolbar externally.
   */
  externalToolbar?: boolean;
  /**
   * Content rendered above the editor inside the same flex column that
   * shares width with the comments panel, so it stays aligned with the editor.
   */
  headerContent?: React.ReactNode;
  liveblocksRoomId?: string | null;
  onEditorInstance?: (editor: TiptapEditor | null) => void;
  onContentReady?: () => void;
  /**
   * Fired when the user clicks the editor body (not the header). Hosts use
   * this to enter inline edit mode without the header (title, metadata bar)
   * triggering the transition.
   */
  onBodyClick?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  scrollMode?: "inner" | "outer";
  showComments?: boolean;
};

export function EditorWithComments({
  value,
  onChange,
  externalToolbar = false,
  headerContent,
  liveblocksRoomId,
  onEditorInstance,
  onContentReady,
  onBodyClick,
  placeholder,
  readOnly,
  scrollMode = "outer",
  showComments = true,
}: Readonly<EditorWithCommentsProps>) {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const liveblocksEnabled = !!liveblocksRoomId;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Formatting toolbar — spans full width above the editor+comments split */}
      {!(readOnly || externalToolbar) && (
        <RichTextToolbar
          editor={editor}
          hasLiveblocksExtension={liveblocksEnabled}
          onPasteMarkdown={(markdown) => editor?.resetContent(markdown)}
          readOnly={readOnly}
        />
      )}

      {/* Scrollable area: editor + anchored comments side by side */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex min-h-full min-w-0 items-stretch">
          <div className="relative mx-auto flex min-w-0 max-w-[900px] flex-1 flex-col">
            {headerContent}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: click-to-edit wrapper; keyboard users enter edit mode by focusing the editor directly */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
            {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: see above */}
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col",
                onBodyClick && readOnly && "cursor-text"
              )}
              onClick={onBodyClick}
            >
              <EditorContent
                externalToolbar
                liveblocksRoomId={
                  liveblocksEnabled ? liveblocksRoomId : undefined
                }
                onChange={onChange}
                onContentReady={onContentReady}
                onEditorReady={(editor) => {
                  setEditor(editor);
                  onEditorInstance?.(editor);
                }}
                placeholder={placeholder}
                readOnly={readOnly}
                scrollMode={scrollMode}
                value={value}
              />
            </div>
          </div>

          {liveblocksEnabled && (
            <Suspense fallback={null}>
              {/* Floating comments on mobile/tablet (< 1280px) */}
              <div className={showComments ? "xl:hidden" : "hidden"}>
                <OptionalComments
                  editor={editor}
                  mode="floating"
                  roomId={liveblocksRoomId}
                />
              </div>

              {/* Anchored comments on desktop (>= 1280px) */}
              <div className={showComments ? "hidden xl:block" : "hidden"}>
                <OptionalComments
                  editor={editor}
                  mode="anchored"
                  roomId={liveblocksRoomId}
                />
              </div>
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
