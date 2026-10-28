"use client";

import { useIsOnDocSync } from "@repo/collaboration/client/doc-sync-room";
import { RichTextToolbar } from "@repo/rich-text/rich-text-toolbar";
import type { ComponentProps } from "react";

/** `RichTextToolbar` for a document editor; Add Comment follows {@link useEditorHasLiveblocksExtension}. */
export function DocumentRichTextToolbar({
  hasLiveblocksExtension = false,
  ...props
}: Readonly<ComponentProps<typeof RichTextToolbar>>) {
  const editorHasLiveblocksExtension = useEditorHasLiveblocksExtension(
    hasLiveblocksExtension
  );
  return (
    <RichTextToolbar
      {...props}
      hasLiveblocksExtension={editorHasLiveblocksExtension}
    />
  );
}

/**
 * Whether the editor carries the Liveblocks extension whose storage the comment
 * surfaces (Add Comment, `FloatingComposer`) need (ISS-9849). Under a
 * `DocSyncRoom` it carries none, so they are off until ISS-11216 (PLN-2189
 * AC-008).
 */
export function useEditorHasLiveblocksExtension(
  editorUsesLiveblocksContent: boolean
): boolean {
  const isOnDocSync = useIsOnDocSync();
  return editorUsesLiveblocksContent && !isOnDocSync;
}
