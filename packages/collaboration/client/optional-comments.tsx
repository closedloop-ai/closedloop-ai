"use client";

import "@liveblocks/react-tiptap/styles.css";
import "@liveblocks/react-ui/styles.css";
import "./comments.css";
import "./inbox.css";

import type { AnchoredThreadsProps } from "@liveblocks/react-tiptap";
import { FloatingComposer, FloatingToolbar } from "@liveblocks/react-tiptap";
import { DocumentThreadAnchorStatus } from "@repo/api/src/types/comment";
import { useEffect, useState } from "react";
import { useConstrainFloatingWithinEditor } from "./use-constrain-floating-within-editor";

const ANCHOR_PREVIEW_MAX_LEN = 150;

type OptionalCommentsProps = {
  editor: AnchoredThreadsProps["editor"];
  roomId: string | null | undefined;
  /**
   * The version of the document the user is editing. Stamped into the
   * `FloatingComposer`'s default metadata so newly-created threads carry
   * a `version` field reflecting the user's view at composition time. The
   * webhook handler then mirrors this value into the DB `createdAtVersion`
   * column. Omit for non-versioned rooms.
   */
  currentVersion?: number;
};

/**
 * Renders the Liveblocks floating toolbar and composer when in a Liveblocks
 * room. Threads are displayed by the host's feed rail, not here.
 */
export function OptionalComments({
  editor,
  roomId,
  currentVersion,
}: Readonly<OptionalCommentsProps>) {
  if (!roomId) {
    return null;
  }

  return <CommentsWithHooks currentVersion={currentVersion} editor={editor} />;
}

function CommentsWithHooks({
  editor,
  currentVersion,
}: Readonly<{
  editor: AnchoredThreadsProps["editor"];
  currentVersion?: number;
}>) {
  useConstrainFloatingWithinEditor(editor);
  const anchorPreview = useSelectionAnchorPreview(editor);
  const metadata =
    currentVersion === undefined
      ? { anchorPreview, anchorStatus: DocumentThreadAnchorStatus.Anchored }
      : {
          anchorPreview,
          anchorStatus: DocumentThreadAnchorStatus.Anchored,
          version: currentVersion,
        };

  return (
    <>
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
