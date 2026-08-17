"use client";

import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { useCallback, useRef, useState } from "react";

const WIDE_COMMENTS_RAIL_QUERY = "(min-width: 1025px)";

/**
 * Owns the prototype-default comments visibility without auto-opening a modal
 * sheet at narrow widths. A new Branch identity resets to the viewport default.
 */
export function useBranchCommentsControl(identity: string | null) {
  const wideRail = useMediaQuery(WIDE_COMMENTS_RAIL_QUERY);
  const [selection, setSelection] = useState<{
    identity: string | null;
    open: boolean;
  } | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const open = selection?.identity === identity ? selection.open : wideRail;
  const onOpenChange = useCallback(
    (nextOpen: boolean) => setSelection({ identity, open: nextOpen }),
    [identity]
  );

  return { onOpenChange, open, toggleRef };
}
