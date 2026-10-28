"use client";

import { type KeyboardEvent, useEffect, useRef } from "react";

/**
 * ISS-12302's save behavior for a typed custom-field editor on the Details
 * tab, opt-in so the Issue page keeps its blur-only editors:
 *
 * - Enter blurs, so the blur's one commit path runs;
 * - Escape puts back the last saved draft, and the blur after it writes
 *   nothing;
 * - a blur with no typing writes nothing;
 * - a refused write puts back the last saved draft, and only when it is the
 *   newest write, so an earlier refusal never undoes a later save.
 *
 * Each write settles on its own promise: a mutation's per-call `mutate`
 * callbacks fire only for its latest call, so with two saves in flight the
 * earlier one's success would never be recorded.
 *
 * Disabled, every member is inert: `shouldWrite` is always true and `commit`
 * calls `mutate(variables)` alone, so the editor writes exactly as before.
 */
export function useInlineCommit(
  enabled: boolean,
  savedDraft: string,
  restore: (draft: string) => void
) {
  const touched = useRef(false);
  const saved = useRef(savedDraft);
  const writes = useRef({ confirmed: 0, latest: 0 });
  useEffect(() => {
    saved.current = savedDraft;
  }, [savedDraft]);

  return {
    markTouched: () => {
      touched.current = true;
    },
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (!enabled) {
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        touched.current = false;
        restore(saved.current);
        event.currentTarget.blur();
      }
    },
    shouldWrite: () => !enabled || touched.current,
    /** Writes `variables`; enabled, the write records or restores `draft`. */
    commit: <V>(
      mutation: InlineCommitMutation<V>,
      variables: V,
      draft: string
    ) => {
      if (!enabled) {
        mutation.mutate(variables);
        return;
      }
      touched.current = false;
      writes.current.latest += 1;
      const write = writes.current.latest;
      // The rejection is handled here; the shared mutation toast reports it.
      mutation.mutateAsync(variables).then(
        () => {
          if (write > writes.current.confirmed) {
            writes.current.confirmed = write;
            saved.current = draft;
          }
        },
        () => {
          if (write === writes.current.latest) {
            restore(saved.current);
          }
        }
      );
    },
  };
}

type InlineCommitMutation<V> = {
  mutate: (variables: V) => void;
  mutateAsync: (variables: V) => Promise<unknown>;
};
