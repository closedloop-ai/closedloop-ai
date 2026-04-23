"use client";

import type { TiptapEditor } from "@repo/rich-text";
import { useCallback, useEffect, useRef, useState } from "react";

type UseInlineEditModeConfig = {
  isLocked: boolean;
  /**
   * Tiptap editor instance used to auto-focus the body when the user enters
   * edit mode, so they can start typing immediately without a second click.
   * Optional because the hook callsite may run before the editor is ready;
   * focus is deferred until the editor becomes available.
   */
  editor?: TiptapEditor | null;
};

/**
 * Sticky inline edit mode for document editor hosts.
 * - `isEditing` starts `false`; call `enterEditMode(event?)` to switch to edit.
 * - If `event` is supplied (a pointer event), the cursor is placed at the
 *   clicked position; otherwise it falls back to the document end.
 * - Once entered, it does NOT exit on outside click; the user stays in edit
 *   mode until the component unmounts (i.e. navigates away).
 * - When `isLocked` is true (e.g. viewing a historical version) the hook is
 *   permanently read-only regardless of entry attempts.
 */
export function useInlineEditMode({
  isLocked,
  editor,
}: UseInlineEditModeConfig) {
  const [isEditing, setIsEditing] = useState(false);
  const pendingFocusPosRef = useRef<number | null>(null);
  const hasFocusedRef = useRef(false);

  const enterEditMode = useCallback(
    (event?: Pick<MouseEvent, "clientX" | "clientY">) => {
      if (isLocked) {
        return;
      }
      if (event && editor) {
        const coords = editor.view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        pendingFocusPosRef.current = coords?.pos ?? null;
      }
      setIsEditing(true);
    },
    [isLocked, editor]
  );

  const effectiveIsEditing = isEditing && !isLocked;

  // Focus the editor the first time both edit mode is active AND the editor
  // instance is available. Runs after child effects have flipped `editable`.
  useEffect(() => {
    if (!(effectiveIsEditing && editor) || hasFocusedRef.current) {
      return;
    }
    const pos = pendingFocusPosRef.current;
    if (pos == null) {
      editor.commands.focus("end");
    } else {
      editor.commands.focus(pos);
    }
    hasFocusedRef.current = true;
    pendingFocusPosRef.current = null;
  }, [effectiveIsEditing, editor]);

  return {
    isEditing: effectiveIsEditing,
    enterEditMode,
  };
}
