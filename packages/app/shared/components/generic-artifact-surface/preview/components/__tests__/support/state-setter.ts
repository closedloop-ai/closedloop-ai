import type { Dispatch, SetStateAction } from "react";

/**
 * A `useState` setter outside React: it applies value and updater forms to a
 * held value, so a model builder's `setFilters` callback can be driven and its
 * result read back.
 */
export function createStateSetter<T>(initial: T): {
  current: () => T;
  set: Dispatch<SetStateAction<T>>;
} {
  let state = initial;
  return {
    current: () => state,
    set: (update) => {
      state = update instanceof Function ? update(state) : update;
    },
  };
}
