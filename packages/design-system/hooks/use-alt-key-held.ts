"use client";

import { useEffect, useState } from "react";

/**
 * Whether `Alt`/`Option` is held RIGHT NOW (ISS-8930, whitlockk review cid 3929275022).
 *
 * Exists because `draggable` is an HTML ATTRIBUTE the browser reads when the
 * drag threshold is crossed, and native `dragstart` fires — and ends the pointer
 * stream — before any pointer handler could intervene. A row that must choose
 * between native drag and a pointer drag therefore cannot decide inside its
 * pointer handler at all; it has to render the attribute from live modifier
 * state, which is what this reports.
 *
 * Resynced from EVERY key event's `altKey` rather than from `Alt`'s own
 * keydown/keyup, so a press or release that arrives as part of a chord still
 * lands, and a keydown that repeats cannot desync it.
 *
 * Cleared on blur and on a hidden document, because a window or tab switch taken
 * WITH the key down consumes its keyup: a stuck `true` would leave native drag
 * dead until the user pressed and released `Alt` again. The reverse — regaining
 * focus with the key already down — reports `false` until the next key event,
 * which is the pre-modifier behaviour and so the safe direction to be wrong in.
 */
export function useAltKeyHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const syncFromKey = (event: Event) => {
      if (event instanceof globalThis.KeyboardEvent) {
        setHeld(event.altKey);
      }
    };
    const clear = () => setHeld(false);
    const onVisibilityChange = () => {
      if (globalThis.document.visibilityState === DOCUMENT_HIDDEN) {
        clear();
      }
    };
    globalThis.addEventListener("keydown", syncFromKey);
    globalThis.addEventListener("keyup", syncFromKey);
    globalThis.addEventListener("blur", clear);
    globalThis.document.addEventListener(
      "visibilitychange",
      onVisibilityChange
    );
    return () => {
      globalThis.removeEventListener("keydown", syncFromKey);
      globalThis.removeEventListener("keyup", syncFromKey);
      globalThis.removeEventListener("blur", clear);
      globalThis.document.removeEventListener(
        "visibilitychange",
        onVisibilityChange
      );
      setHeld(false);
    };
  }, [enabled]);

  // Gated on the way OUT as well as the way in, so a gate that closes while the
  // key is down cannot leave one render reading a modifier nobody is watching.
  return enabled && held;
}

const DOCUMENT_HIDDEN = "hidden";
