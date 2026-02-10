"use client";

import { OptionalComments } from "@repo/collaboration";
import type { Editor } from "@tiptap/react";
import { useState } from "react";
import { EditorContent } from "@/components/artifact-editor/editor-content";

export type EditorWithCommentsProps = {
  value: string;
  onChange: (value: string) => void;
  contentResetKey?: number;
  contentResetValue?: string;
  liveblocksRoomId?: string | null;
  placeholder?: string;
  readOnly?: boolean;
  scrollMode?: "inner" | "outer";
};

export function EditorWithComments({
  value,
  onChange,
  contentResetKey,
  contentResetValue,
  liveblocksRoomId,
  placeholder,
  readOnly,
  scrollMode = "outer",
}: Readonly<EditorWithCommentsProps>) {
  const [editor, setEditor] = useState<Editor | null>(null);

  const liveblocksEnabled = !!liveblocksRoomId;

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="relative flex min-h-full min-w-0 items-stretch">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <EditorContent
            contentResetKey={contentResetKey}
            contentResetValue={contentResetValue}
            liveblocksRoomId={liveblocksEnabled ? liveblocksRoomId : undefined}
            onChange={onChange}
            onEditorReady={setEditor}
            placeholder={placeholder}
            readOnly={readOnly}
            scrollMode={scrollMode}
            value={value}
          />
        </div>

        {liveblocksEnabled && (
          <>
            {/* Floating comments on mobile/tablet (< 1280px) */}
            <div className="xl:hidden">
              <OptionalComments
                editor={editor}
                mode="floating"
                roomId={liveblocksRoomId}
              />
            </div>

            {/* Anchored comments on desktop (>= 1280px) */}
            <div className="hidden xl:block">
              <OptionalComments
                editor={editor}
                mode="anchored"
                roomId={liveblocksRoomId}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
