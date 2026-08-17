import type { MouseEvent } from "react";

/**
 * True when a click on an in-app `<Link>` should be left to the browser rather
 * than run the app's own side-effect + client navigation: a non-primary button
 * (middle/right), or a primary click with a modifier held (Cmd/Ctrl to open in a
 * new tab, Shift for a new window, Alt to download). In those cases the browser
 * opens the link's `href` on its own, and the current tab's state must be left
 * untouched.
 *
 * ISS-4534 (wongk): the Sessions recovery Link ran its "clear filters + reload"
 * side effect on EVERY click, so a Cmd/Ctrl-click that opened the clean Sessions
 * URL in a new tab ALSO wiped the filters in the tab the user meant to keep. Gate
 * the side effect behind `!isModifiedClick(event)` so a modified click only
 * navigates.
 */
export function isModifiedClick(event: MouseEvent): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}
