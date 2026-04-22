"use client";

import { useCallback, useState } from "react";

type UseInlineEditModeConfig = {
  isLocked: boolean;
};

/**
 * Sticky inline edit mode for document editor hosts.
 * - `isEditing` starts `false`; call `enterEditMode()` to switch to edit.
 * - Once entered, it does NOT exit on outside click; the user stays in edit
 *   mode until the component unmounts (i.e. navigates away).
 * - When `isLocked` is true (e.g. viewing a historical version) the hook is
 *   permanently read-only regardless of entry attempts.
 */
export function useInlineEditMode({ isLocked }: UseInlineEditModeConfig) {
  const [isEditing, setIsEditing] = useState(false);

  const enterEditMode = useCallback(() => {
    if (isLocked) {
      return;
    }
    setIsEditing(true);
  }, [isLocked]);

  const effectiveIsEditing = isEditing && !isLocked;

  return {
    isEditing: effectiveIsEditing,
    enterEditMode,
  };
}
