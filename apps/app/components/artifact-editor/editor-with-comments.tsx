"use client";

import { OptionalComments } from "@repo/collaboration";
import type { Editor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { EditorContent } from "@/components/artifact-editor/editor-content";

type CommentsMode = "floating" | "anchored";

type EditorWithCommentsProps = {
  value: string;
  onChange: (value: string) => void;
  contentResetKey?: number;
  contentResetValue?: string;
  enableLiveblocks?: boolean;
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
  enableLiveblocks = true,
  liveblocksRoomId,
  placeholder,
  readOnly,
  scrollMode = "outer",
}: Readonly<EditorWithCommentsProps>) {
  const commentsMode = useCommentsMode();
  const [editor, setEditor] = useState<Editor | null>(null);
  const showCollaboration = enableLiveblocks;

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="relative flex min-h-full min-w-0 items-stretch">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <EditorContent
            contentResetKey={contentResetKey}
            contentResetValue={contentResetValue}
            enableLiveblocks={enableLiveblocks}
            liveblocksRoomId={liveblocksRoomId}
            onChange={onChange}
            onEditorReady={setEditor}
            placeholder={placeholder}
            readOnly={readOnly}
            scrollMode={scrollMode}
            value={value}
          />
        </div>

        {showCollaboration && editor && (
          <OptionalComments
            editor={editor}
            mode={commentsMode}
            roomId={liveblocksRoomId}
          />
        )}
      </div>
    </div>
  );
}

function useCommentsMode() {
  const [mode, setMode] = useState<CommentsMode>("floating");

  useEffect(() => {
    if (!globalThis.window) {
      return;
    }

    const media = globalThis.matchMedia("(min-width: 1280px)");
    const updateMode = () => {
      setMode(media.matches ? "anchored" : "floating");
    };

    updateMode();

    if (media.addEventListener) {
      media.addEventListener("change", updateMode);
      return () => media.removeEventListener("change", updateMode);
    }

    media.addEventListener("change", updateMode);
    return () => media.removeEventListener("change", updateMode);
  }, []);

  return mode;
}
