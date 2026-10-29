"use client";

import { useCallback, useRef } from "react";
import {
  SettingsDismissMode as DismissMode,
  type SettingsDismissMode,
} from "../components/settings-dismissal";

/**
 * Returns focus to whatever held it when the Settings modal opened (ISS-8978,
 * WCAG 2.4.3 Focus Order).
 *
 * The shell has to own this because Radix does NOT do it for a dialog with no
 * trigger. A modal `DialogContent` cancels the focus scope's own restore and
 * focuses `DialogTrigger` instead; Settings is opened by a route rather than by
 * a button, so that ref is null and the user is dropped on `document.body` with
 * no way back to where they were. Cancelling Radix's handler and restoring the
 * captured element is the only path that reaches the real invoking control.
 *
 * OVERLAY ONLY, and that boundary is load-bearing. A cold dismiss is a real
 * navigation, and Radix dispatches this a macrotask AFTER the content unmounts —
 * by then the destination route has mounted and taken focus. Restoring there
 * would cancel Radix's handling and re-focus an element captured on the page the
 * user just left, which for a cold deep link is that page's `document.body`:
 * still connected, so no liveness guard can filter it, and focusing it drops the
 * user at the top of a page they have only just arrived on.
 *
 * The element is captured during render rather than in an effect: the focus
 * scope lives BELOW this hook's component, so its effect has already moved focus
 * into the dialog by the time a parent effect could read it.
 */
export function useSettingsFocusRestoration(
  mode: SettingsDismissMode
): (event: Event) => void {
  const invoker = useRef<Element | null | undefined>(undefined);
  if (invoker.current === undefined) {
    invoker.current = globalThis.document?.activeElement ?? null;
  }

  return useCallback(
    (event: Event) => {
      if (mode !== DismissMode.Overlay) {
        return;
      }
      event.preventDefault();
      const element = invoker.current;
      // A route change can retire the invoking control while Settings is open.
      // No liveness guard is needed for that: focusing a detached node is a
      // no-op, so focus simply stays where Radix left it.
      if (element instanceof globalThis.HTMLElement) {
        element.focus();
      }
    },
    [mode]
  );
}
