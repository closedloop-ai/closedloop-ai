"use client";

import "@liveblocks/react-tiptap/styles.css";
import "@liveblocks/react-ui/styles.css";
import "./comments.css";

import { useThreads } from "@liveblocks/react/suspense";
import type { AnchoredThreadsProps } from "@liveblocks/react-tiptap";
import {
  AnchoredThreads,
  FloatingComposer,
  FloatingThreads,
  FloatingToolbar,
} from "@liveblocks/react-tiptap";
import { Thread } from "@liveblocks/react-ui";
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

  const anchoredThreadIds = getAnchoredThreadIds(editor);
  const hasAnchoredThreads = threads.some(
    (thread) => !thread.resolved && anchoredThreadIds.has(thread.id)
  );
  const unanchoredThreads = threads.filter(
    (thread) => !(thread.resolved || anchoredThreadIds.has(thread.id))
  );

  if (mode === "anchored") {
    return (
      <>
        {hasAnchoredThreads ? (
          <div className="pr-4 pl-2">
            <AnchoredThreads
              className="lb-collab-anchored-threads"
              editor={editor}
              threads={threads}
            />
          </div>
        ) : null}
        <UnanchoredThreads threads={unanchoredThreads} />
      </>
    );
  }

  return (
    <>
      <FloatingThreads
        className="lb-collab-floating lb-collab-floating-threads"
        editor={editor}
        threads={threads}
      />
      <UnanchoredThreads floating threads={unanchoredThreads} />
    </>
  );
}

type ThreadDataItem = ReturnType<typeof useThreads>["threads"][number];

function UnanchoredThreads({
  floating,
  threads,
}: Readonly<{ floating?: boolean; threads: ThreadDataItem[] }>) {
  if (threads.length === 0) {
    return null;
  }

  const className = floating
    ? "lb-collab-unanchored-threads lb-collab-unanchored-threads--floating"
    : "lb-collab-unanchored-threads";

  return (
    <div className={className}>
      {threads.map((thread) => (
        <Thread key={thread.id} thread={thread} />
      ))}
    </div>
  );
}

/**
 * Walk the editor's JSON content to find all thread IDs referenced by
 * liveblocksCommentMark marks. These are threads anchored to text selections
 * in the document. Threads NOT in this set are "unanchored" (e.g., created
 * server-side via the MCP tool).
 */
function getAnchoredThreadIds(
  editor: AnchoredThreadsProps["editor"]
): Set<string> {
  const ids = new Set<string>();
  if (!editor) {
    return ids;
  }

  const json = editor.getJSON();
  collectThreadIds(json, ids);
  return ids;
}

function collectThreadIds(
  node: Record<string, unknown>,
  ids: Set<string>
): void {
  const marks = node.marks as
    | { type?: string; attrs?: Record<string, unknown> }[]
    | undefined;
  if (marks) {
    for (const mark of marks) {
      if (
        mark.type === "liveblocksCommentMark" &&
        typeof mark.attrs?.threadId === "string"
      ) {
        ids.add(mark.attrs.threadId);
      }
    }
  }

  const content = node.content as Record<string, unknown>[] | undefined;
  if (content) {
    for (const child of content) {
      collectThreadIds(child, ids);
    }
  }
}
