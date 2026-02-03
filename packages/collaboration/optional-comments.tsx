"use client";

import { useThreads } from "@liveblocks/react/suspense";
import type { AnchoredThreadsProps } from "@liveblocks/react-tiptap";
import {
  FloatingComposer,
  FloatingThreads,
  FloatingToolbar,
} from "@liveblocks/react-tiptap";
import { useConstrainFloatingWithinEditor } from "./use-constrain-floating-within-editor";

type OptionalCommentsProps = {
  editor: AnchoredThreadsProps["editor"];
  roomId: string | null | undefined;
};

/**
 * Renders FloatingComposer and AnchoredThreads when in a Liveblocks room.
 * Must be called inside OptionalArtifactRoom.
 *
 * When roomId is null/undefined, returns null (no comments UI).
 * When roomId exists, assumes we're wrapped in ArtifactRoom and uses Liveblocks hooks.
 */
export function OptionalComments({
  editor,
  roomId,
}: Readonly<OptionalCommentsProps>) {
  // If no roomId, don't render comments UI
  if (!roomId) {
    return null;
  }

  // We have a roomId, rendering hooks-based component
  return <CommentsWithHooks editor={editor} />;
}

/**
 * Internal component that uses Liveblocks hooks.
 * Only rendered when roomId exists, so safe to use hooks.
 */
function CommentsWithHooks({
  editor,
}: Readonly<{
  editor: AnchoredThreadsProps["editor"];
}>) {
  const { threads } = useThreads();
  useConstrainFloatingWithinEditor(editor);

  return (
    <>
      {/* <AnchoredThreads
        className="anchored-threads"
        editor={editor}
        threads={threads}
      /> */}
      <FloatingThreads
        className="lb-collab-floating lb-collab-floating-threads"
        editor={editor}
        threads={threads}
      />
      <FloatingComposer
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
