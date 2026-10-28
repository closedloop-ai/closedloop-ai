"use client";

import { useIsomorphicLayoutEffect } from "@closedloop-ai/design-system/hooks/use-isomorphic-layout-effect";
import { useRef } from "react";

/** Reports a grid's listed rows only when their ordered identities change. */
export function useGridRenderedItemsChange<T>({
  getRowId,
  onChange,
  renderedItems,
}: {
  getRowId: (item: T) => string;
  onChange?: (renderedItems: readonly T[]) => void;
  renderedItems: readonly T[];
}) {
  const previousIds = useRef<readonly string[] | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (!onChange) {
      previousIds.current = null;
      return;
    }
    const nextIds = renderedItems.map(getRowId);
    if (sameIds(previousIds.current, nextIds)) {
      return;
    }
    previousIds.current = nextIds;
    onChange(renderedItems);
  }, [getRowId, onChange, renderedItems]);
}

function sameIds(
  previous: readonly string[] | null,
  next: readonly string[]
): boolean {
  if (previous === null || previous.length !== next.length) {
    return false;
  }
  return previous.every((id, index) => id === next[index]);
}
