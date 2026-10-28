"use client";

import { useCallback, useMemo, useRef } from "react";

/**
 * Per-tab open/closed memory for the comments rail (Ottilie, kick-off ruling
 * 2026-09-23). A hidden tab (Details) never shows the rail, so leaving it
 * restores whatever the next tab last had.
 */
export type CommentsTabMemory<Tab extends string> = Partial<
  Record<Tab, boolean>
>;

export function rememberCommentsOpen<Tab extends string>(
  memory: CommentsTabMemory<Tab>,
  tab: Tab,
  open: boolean,
  hiddenTabs: readonly Tab[]
): CommentsTabMemory<Tab> {
  return hiddenTabs.includes(tab) ? memory : { ...memory, [tab]: open };
}

export function commentsOpenForTab<Tab extends string>(
  memory: CommentsTabMemory<Tab>,
  tab: Tab,
  hiddenTabs: readonly Tab[]
): boolean {
  return !hiddenTabs.includes(tab) && memory[tab] === true;
}

/** Records the leaving tab's state and answers whether the rail opens on the next one. */
export function commentsOpenAfterTabChange<Tab extends string>({
  from,
  hiddenTabs,
  memory,
  open,
  to,
}: {
  from: Tab;
  hiddenTabs: readonly Tab[];
  memory: CommentsTabMemory<Tab>;
  open: boolean;
  to: Tab;
}): { memory: CommentsTabMemory<Tab>; open: boolean } {
  const next = rememberCommentsOpen(memory, from, open, hiddenTabs);
  return { memory: next, open: commentsOpenForTab(next, to, hiddenTabs) };
}

/** Ref-backed memory for a host whose open state is controlled elsewhere. */
export function useCommentsTabMemory<Tab extends string>(
  initial: CommentsTabMemory<Tab>,
  hiddenTabs: readonly Tab[]
) {
  const memoryRef = useRef(initial);
  const remember = useCallback(
    (tab: Tab, open: boolean) => {
      memoryRef.current = rememberCommentsOpen(
        memoryRef.current,
        tab,
        open,
        hiddenTabs
      );
    },
    [hiddenTabs]
  );
  const changeTab = useCallback(
    (from: Tab, to: Tab, open: boolean) => {
      const result = commentsOpenAfterTabChange({
        from,
        hiddenTabs,
        memory: memoryRef.current,
        open,
        to,
      });
      memoryRef.current = result.memory;
      return result.open;
    },
    [hiddenTabs]
  );
  return useMemo(() => ({ changeTab, remember }), [changeTab, remember]);
}
