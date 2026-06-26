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
import { useEffect, useState } from "react";
import { useConstrainFloatingWithinEditor } from "./use-constrain-floating-within-editor";

const ANCHOR_PREVIEW_MAX_LEN = 150;

type OptionalCommentsProps = {
  editor: AnchoredThreadsProps["editor"];
  roomId: string | null | undefined;
  mode?: CommentsMode;
  /**
   * When false, do NOT render the gutter `AnchoredThreads`/`FloatingThreads`
   * — used when the Feed sidebar is mounted at the host level and owns
   * thread display. `FloatingComposer` and `FloatingToolbar` continue to
   * render either way (they own thread creation, which is unchanged).
   *
   * Default true preserves today's behavior for any consumer that hasn't
   * been migrated to the rail.
   */
  renderGutterThreads?: boolean;
  /**
   * The version of the document the user is editing. Stamped into the
   * `FloatingComposer`'s default metadata so newly-created threads carry
   * a `version` field reflecting the user's view at composition time. The
   * webhook handler then mirrors this value into the DB `createdAtVersion`
   * column. Omit for non-versioned rooms.
   */
  currentVersion?: number;
};

type CommentsMode = "floating" | "anchored";

/**
 * Renders liveblocks floating toolbar, composer and threads when in a Liveblocks room.
 */
export function OptionalComments({
  editor,
  mode = "floating",
  roomId,
  renderGutterThreads = true,
  currentVersion,
}: Readonly<OptionalCommentsProps>) {
  if (!roomId) {
    return null;
  }

  return (
    <CommentsWithHooks
      currentVersion={currentVersion}
      editor={editor}
      mode={mode}
      renderGutterThreads={renderGutterThreads}
    />
  );
}

function CommentsWithHooks({
  editor,
  mode,
  renderGutterThreads,
  currentVersion,
}: Readonly<{
  editor: AnchoredThreadsProps["editor"];
  mode: CommentsMode;
  renderGutterThreads: boolean;
  currentVersion?: number;
}>) {
  useConstrainFloatingWithinEditor(editor);
  const anchorPreview = useSelectionAnchorPreview(editor);
  const metadata =
    currentVersion === undefined
      ? { anchorPreview, anchorStatus: "anchored" as const }
      : {
          anchorPreview,
          anchorStatus: "anchored" as const,
          version: currentVersion,
        };

  return (
    <>
      {renderGutterThreads && <Threads editor={editor} mode={mode} />}
      <FloatingComposer
        autoFocus
        className="lb-collab-floating lb-collab-floating-composer"
        editor={editor}
        metadata={metadata}
      />
      <FloatingToolbar
        className="lb-collab-floating lb-collab-floating-toolbar"
        editor={editor}
      />
    </>
  );
}

/**
 * Subscribes to the editor's selection and returns a trimmed snapshot of the
 * currently-selected text, intended for use as `ThreadMetadata.anchorPreview`
 * when a new thread is created via the FloatingComposer.
 *
 * Uses ProseMirror's `doc.textBetween(from, to, " ")` so inline-formatted
 * selections (bold/italic/links — which ProseMirror splits across text nodes)
 * render as a single contiguous string instead of just the first fragment.
 */
function useSelectionAnchorPreview(
  editor: AnchoredThreadsProps["editor"]
): string {
  const [preview, setPreview] = useState("");

  useEffect(() => {
    if (!editor) {
      return;
    }
    const update = () => {
      const { from, to } = editor.state.selection;
      if (from === to) {
        return;
      }
      const text = editor.state.doc.textBetween(from, to, " ").trim();
      if (!text) {
        return;
      }
      setPreview(text.slice(0, ANCHOR_PREVIEW_MAX_LEN));
    };
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  return preview;
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
