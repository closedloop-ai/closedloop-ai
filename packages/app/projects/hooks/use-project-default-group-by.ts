"use client";

import { useEffect, useRef } from "react";

/**
 * The manual-ordering flag resolves after mount, so a group still sitting on
 * the old default moves to the new one rather than staying stale. A group the
 * link chose is left alone, and so is one the reader moved off the default.
 */
export function useSyncProjectDefaultGroupBy(
  {
    groupBy,
    setGroupBy,
  }: { groupBy: string; setGroupBy: (value: string) => void },
  defaultGroupBy: string,
  query: string
) {
  const previousDefault = useRef(defaultGroupBy);
  // Read once at mount: the route state drops a `group` equal to the default
  // from the URL, so a link's explicit Status would look unset after the flag
  // flips.
  const hasExplicitGroup = useRef(new URLSearchParams(query).has("group"));
  useEffect(() => {
    if (previousDefault.current === defaultGroupBy) {
      return;
    }
    if (groupBy === previousDefault.current && !hasExplicitGroup.current) {
      setGroupBy(defaultGroupBy);
    }
    previousDefault.current = defaultGroupBy;
  }, [defaultGroupBy, groupBy, setGroupBy]);
}
