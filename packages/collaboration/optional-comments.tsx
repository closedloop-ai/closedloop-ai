"use client";

import "@liveblocks/react-tiptap/styles.css";
import "@liveblocks/react-ui/styles.css";
import "./comments.css";
import "./inbox.css";

import { useThreads } from "@liveblocks/react/suspense";
import type { AnchoredThreadsProps } from "@liveblocks/react-tiptap";
import {
  AnchoredThreads,
  FloatingComposer,
  FloatingThreads,
  FloatingToolbar,
} from "@liveblocks/react-tiptap";
import { useConstrainFloatingWithinEditor } from "./use-constrain-floating-within-editor";

type OptionalCommentsProps = {
  editor: AnchoredThreadsProps["editor"];
  roomId: string | null | undefined;
  mode?: CommentsMode;
};

type CommentsMode = "floating" | "anchored";

/**
 * Renders liveblocks floating toolbar, composer and threads when in a Liveblocks room.
 *
 * @param editor - the editor instance
 * @param mode - "floating" for Google Docs-style floating comments (default), "anchored" for side-by-side layout
 * @param roomId - the liveblocks room ID (if null, no liveblocks components will be rendered)
 */
export function OptionalComments({
  editor,
  mode = "floating",
  roomId,
}: Readonly<OptionalCommentsProps>) {
  if (!roomId) {
    return null;
  }

  return <CommentsWithHooks editor={editor} mode={mode} />;
}

function CommentsWithHooks({
  editor,
  mode,
}: Readonly<{
  editor: AnchoredThreadsProps["editor"];
  mode: CommentsMode;
}>) {
  useConstrainFloatingWithinEditor(editor);

  return (
    <>
      <Threads editor={editor} mode={mode} />
      <FloatingComposer
        autoFocus
        className="lb-collab-floating lb-collab-floating-composer"
        editor={editor}
      />
      <FloatingToolbar
        className="lb-collab-floating lb-collab-floating-toolbar"
        editor={editor}
      />
    </>
  );
}

function Threads({
  editor,
  mode,
}: Readonly<{
  editor: AnchoredThreadsProps["editor"];
  mode: CommentsMode;
}>) {
  const { threads } = useThreads();
  const hasThreads = threads.some((thread) => !thread.resolved);

  if (mode === "anchored") {
    return hasThreads ? (
      <div className="pr-4 pl-2">
        <AnchoredThreads
          className="lb-collab-anchored-threads"
          editor={editor}
          threads={threads}
        />
      </div>
    ) : null;
  }

  return (
    <FloatingThreads
      className="lb-collab-floating lb-collab-floating-threads"
      editor={editor}
      threads={threads}
    />
  );
}
