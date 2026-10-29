"use client";

import {
  EditorWithAnchoredComments,
  type EditorWithAnchoredCommentsProps,
} from "./editor-with-anchored-comments";

/**
 * Collaborative editor with optional Liveblocks comment threads.
 * When `liveblocksRoomId` is provided, this component must be rendered
 * inside an `OptionalDocumentRoom` (or equivalent Liveblocks RoomProvider).
 */
export function CollaborativeEditorBody(
  props: Readonly<EditorWithAnchoredCommentsProps>
) {
  return <EditorWithAnchoredComments {...props} />;
}
