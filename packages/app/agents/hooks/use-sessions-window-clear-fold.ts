"use client";

import { useCallback, useRef } from "react";
import type { SessionCustomDateWindow } from "../lib/session-custom-date-window";

/**
 * ISS-9107 AC7 / ISS-9822 — "Clear all" drops the explicit window, and it must
 * reach the URL in the SAME write as the cleared facets.
 *
 * The surface calls this before reporting the view change, so the clear is
 * recorded here and spent by that change rather than issuing a second
 * `replaceListParams` off the same pre-click snapshot — which would restore the
 * `?from=`/`?to=` the first one removed.
 *
 * A window PICK is the mirror of that, not an exemption from it: the surface
 * follows one with a view change too (`updateView({ page: 0 })`, unconditional),
 * so the pick is recorded here as well — it has ALREADY written its own params
 * and its own page reset, and the host reads that to keep the following change
 * from writing a second time. Both v2 hosts read it. A host that does not reads
 * that `page: 0` as a page move still to make from page 2+, and its second
 * write, built from the pre-click params, silently drops the window the reader
 * just chose.
 *
 * ONE implementation for every host that mounts `SessionsListSurfaceV2`. The
 * microtask rule below is the non-obvious half, and a second hand-written copy
 * of it is how two hosts would come to resolve one click differently — so it is
 * extracted ahead of the web v2 host's adoption rather than after a divergence.
 * Both v2 hosts read it now, the desktop shell and the web page, and both read
 * the clear and the pick; which hosts supply
 * `onCustomDateWindowChange` is recorded by the v2 capability-parity ledger,
 * `apps/app/__tests__/sessions-list-v2-host-capability-parity.test.ts`.
 *
 * Both readers are a READ, not a consume: the record is spent by the microtask
 * and by a subsequent window change, never by a caller, because it has to
 * survive every read inside one synchronous event.
 */
export function useSessionsWindowClearFold(
  onCustomDateWindowChange:
    | ((next: SessionCustomDateWindow | null) => void)
    | undefined
): {
  onSurfaceCustomWindowChange:
    | ((next: SessionCustomDateWindow | null) => void)
    | undefined;
  readPendingWindowClear: () => boolean;
  readPendingWindowPick: () => boolean;
} {
  // One record, so the two states cannot both read true and cannot drift apart:
  // a window change is a clear or a pick, never both.
  const pendingWindowWrite = useRef<PendingWindowWrite>(null);
  const handleSurfaceCustomWindowChange = useCallback(
    (next: SessionCustomDateWindow | null) => {
      // A CLEAR writes nothing here: the surface always reports a view change
      // after a window change, and that one write carries the strip. Writing
      // here too would be the second `replaceListParams` off the same pre-click
      // snapshot that this whole seam exists to avoid. A PICK writes its own
      // params INSTEAD of that view change, which is the same one-write rule
      // read from the other end — so it is recorded rather than forgotten.
      if (next === null) {
        pendingWindowWrite.current = "clear";
      } else {
        pendingWindowWrite.current = "pick";
        onCustomDateWindowChange?.(next);
      }
      // Reset on a MICROTASK, not on the next view change. `ActiveFiltersBar`'s
      // "Clear all" fires `clearAllFilters()` and then one `onToggle` per
      // selected value synchronously with no render between, so the host hears
      // several view changes in one click and only the LAST write survives. A
      // flag spent by the first of them lets that last write put `?from=`/`?to=`
      // straight back. Held for the whole synchronous event instead, every write
      // in the click strips, and the flag cannot leak into the next one.
      queueMicrotask(() => {
        pendingWindowWrite.current = null;
      });
    },
    [onCustomDateWindowChange]
  );
  const readPendingWindowClear = useCallback(
    () => pendingWindowWrite.current === "clear",
    []
  );
  const readPendingWindowPick = useCallback(
    () => pendingWindowWrite.current === "pick",
    []
  );
  return {
    // Withheld rather than wrapped when the host holds no handler: the v2
    // toolbar keys the Custom control off this prop's PRESENCE, so a host the
    // window's flag is closed for mounts no control, the surface never reports a
    // window change, and the fold reports no pending clear.
    onSurfaceCustomWindowChange:
      onCustomDateWindowChange === undefined
        ? undefined
        : handleSurfaceCustomWindowChange,
    readPendingWindowClear,
    readPendingWindowPick,
  };
}

/**
 * Which window change this synchronous event carried, or `null` between events.
 */
type PendingWindowWrite = "clear" | "pick" | null;
