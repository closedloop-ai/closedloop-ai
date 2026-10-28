"use client";

import { useEffect, useState } from "react";

/**
 * The value, settling only once it has stopped changing for `delayMs`.
 *
 * Lifted out of `custom-field-reference-table-cell.tsx` (ISS-9724) when the
 * Documents index needed the same thing to keep a server-side search from
 * issuing a request per keystroke. The superseded timer is cleared on every
 * change and on unmount, so an in-flight delay never resolves onto an unmounted
 * component or overwrites a newer value.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);
  return debouncedValue;
}
