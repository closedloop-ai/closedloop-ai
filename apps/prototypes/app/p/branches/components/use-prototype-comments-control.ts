"use client";

import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { useCallback, useEffect, useState } from "react";

const WIDE_COMMENTS_RAIL_QUERY = "(min-width: 1025px)";

/**
 * Keeps the prototype comments rail open by default only when the viewport can
 * support it without compressing Branch Details. A branch change resets the
 * disclosure to the current viewport default.
 */
export function usePrototypeCommentsControl(identity: string | null) {
  const wideRail = useMediaQuery(WIDE_COMMENTS_RAIL_QUERY);
  const [selection, setSelection] = useState<{
    identity: string | null;
    open: boolean;
  } | null>(null);

  useEffect(() => {
    setSelection((current) =>
      current?.identity === identity ? current : null
    );
  }, [identity]);

  const open = selection?.identity === identity ? selection.open : wideRail;
  const onOpenChange = useCallback(
    (nextOpen: boolean) => setSelection({ identity, open: nextOpen }),
    [identity]
  );

  return { onOpenChange, open };
}
