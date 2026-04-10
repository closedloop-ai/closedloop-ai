"use client";

import { OptionalComments } from "@repo/collaboration";
import {
  setEditorMarkdown,
  TiptapPasteMarkdownDialog,
  TiptapToolbar,
} from "@repo/rich-text";
import type { Editor } from "@tiptap/react";
import { Suspense, useCallback, useEffect, useState } from "react";
import { EditorContent } from "@/components/artifact-editor/editor-content";

export type EditorWithCommentsProps = {
  value: string;
  onChange: (value: string) => void;
  contentResetKey?: number;
  contentResetValue?: string;
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
  onEditorInstance?: (editor: Editor | null) => void;
  onContentReady?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  scrollMode?: "inner" | "outer";
  showComments?: boolean;
};

export function EditorWithComments({
  value,
  onChange,
  contentResetKey,
  contentResetValue,
  externalToolbar = false,
  headerContent,
  liveblocksRoomId,
  onEditorInstance,
  onContentReady,
  placeholder,
  readOnly,
  scrollMode = "outer",
  showComments = true,
}: Readonly<EditorWithCommentsProps>) {
  const [editor, setEditor] = useState<Editor | null>(null);

  useEffect(() => {
    onEditorInstance?.(editor);
  }, [editor, onEditorInstance]);

  const [showPasteDialog, setShowPasteDialog] = useState(false);
  const liveblocksEnabled = !!liveblocksRoomId;

  const handleSetContent = useCallback(
    (markdown: string) => {
      setEditorMarkdown(editor, markdown);
    },
    [editor]
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Formatting toolbar — spans full width above the editor+comments split */}
      {!(readOnly || externalToolbar) && (
        <TiptapToolbar
          editor={editor}
          hasLiveblocksExtension={liveblocksEnabled}
          onPasteMarkdown={() => setShowPasteDialog(true)}
          readOnly={readOnly}
        />
      )}

      {!readOnly && (
        <TiptapPasteMarkdownDialog
          onOpenChange={setShowPasteDialog}
          onSetContent={handleSetContent}
          open={showPasteDialog}
        />
      )}

      {/* Scrollable area: editor + anchored comments side by side */}
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex min-h-full min-w-0 items-stretch">
          <div className="relative mx-auto flex min-w-0 max-w-[900px] flex-1 flex-col">
            {headerContent}
            <EditorContent
              contentResetKey={contentResetKey}
              contentResetValue={contentResetValue}
              externalToolbar
              liveblocksRoomId={
                liveblocksEnabled ? liveblocksRoomId : undefined
              }
              onChange={onChange}
              onContentReady={onContentReady}
              onEditorReady={setEditor}
              placeholder={placeholder}
              readOnly={readOnly}
              scrollMode={scrollMode}
              value={value}
            />
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
