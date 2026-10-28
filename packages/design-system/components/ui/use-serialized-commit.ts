"use client";

import { useCallback, useRef } from "react";

/**
 * Serializes a cell's writes: each commit is dispatched only once the one
 * before it has settled.
 *
 * A cell that commits the WHOLE next value (a select, a set of tags, a list of
 * references) puts two replacements in flight at once when the user picks
 * twice quickly, and the loser is whichever the server happens to write last.
 * That is a lost update the commit ledger cannot see, because it is told only
 * whether each write was accepted. A refusal settles its own commit and must
 * not strand the queue behind it, so the tail absorbs the rejection while the
 * caller still receives it.
 *
 * Extracted from `InlineSelectCell` when the tag and reference champions
 * arrived, so the cells that commit whole sets share one queue rule.
 */
export function useSerializedCommit<T>(
  onCommit: (next: T) => Promise<unknown> | void
): (next: T) => Promise<unknown> {
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const tailRef = useRef<Promise<unknown>>(Promise.resolve());

  return useCallback((next: T) => {
    const dispatched = tailRef.current.then(() => onCommitRef.current(next));
    tailRef.current = dispatched.then(ignore, ignore);
    return dispatched;
  }, []);
}

function ignore(): void {
  return undefined;
}
