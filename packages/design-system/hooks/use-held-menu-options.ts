"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Hold an open menu's rows still while its option list churns underneath.
 *
 * Rows are keyed by option id, so React removes one the instant its option
 * leaves the list — detaching the element a click is already aimed at, and the
 * click lands on nothing. Every option the menu has rendered since it opened
 * therefore keeps its place: it shows the live values while its option is
 * present, and the values it was last seen with once that option is gone.
 * Options arriving meanwhile append at the end, where they cannot displace
 * anything the pointer is over.
 *
 * Three separate things, each with exactly one source, so none of them can quietly
 * stop working behind another: which rows exist and in what order is `seenIds`,
 * a row's values while its option is live come from the live list at render, and
 * its values after the option leaves come from `lastSeen`. `lastSeen` is a ref
 * rather than state on purpose — writing it must not re-render, or it would
 * paint held rows on its own and the live refresh would stop being load-bearing.
 *
 * The hold reports rows, never emptiness: `seenIds` only grows, so a caller
 * deciding whether to show an "empty" state must read its own live list.
 *
 * Call this from the menu content itself. Radix unmounts submenu content on
 * close, so the hook's own lifetime is "while open" and no open flag is needed.
 */
export function useHeldMenuOptions<TOption extends { id: string }>(
  options: readonly TOption[]
): TOption[] {
  const [seenIds, setSeenIds] = useState<readonly string[]>(() =>
    options.map((option) => option.id)
  );
  const lastSeenRef = useRef<Map<string, TOption> | null>(null);
  // Seeded once, from the same at-open snapshot that seeds `seenIds`. Never
  // written again during render — the effect below owns every later write.
  lastSeenRef.current ??= new Map(
    options.map((option) => [option.id, option] as const)
  );
  const lastSeen = lastSeenRef.current;

  useEffect(() => {
    for (const option of options) {
      lastSeen.set(option.id, option);
    }
    setSeenIds((previous) => appendUnseenIds(previous, options));
  }, [options, lastSeen]);

  return holdSeenOptions(seenIds, options, lastSeen);
}

/** Every seen row in first-seen order, then whatever the live list has added. */
function holdSeenOptions<TOption extends { id: string }>(
  seenIds: readonly string[],
  live: readonly TOption[],
  lastSeen: ReadonlyMap<string, TOption>
): TOption[] {
  const liveById = new Map(live.map((option) => [option.id, option]));
  const seen = new Set(seenIds);
  const held: TOption[] = [];
  for (const id of seenIds) {
    const option = liveById.get(id) ?? lastSeen.get(id);
    if (option) {
      held.push(option);
    }
  }
  held.push(...live.filter((option) => !seen.has(option.id)));
  return held;
}

/**
 * Returns `previous` itself unless the live list brought an unseen id, so a
 * caller whose `options` array is rebuilt every render (`tagOptions ?? []`)
 * re-runs the effect without re-rendering.
 */
function appendUnseenIds<TOption extends { id: string }>(
  previous: readonly string[],
  live: readonly TOption[]
): readonly string[] {
  const seen = new Set(previous);
  const arrived = live
    .map((option) => option.id)
    .filter((id) => !seen.has(id));
  return arrived.length === 0 ? previous : [...previous, ...arrived];
}
