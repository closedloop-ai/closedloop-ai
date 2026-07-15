import type { DesktopAuthStatus } from "../types/desktop-api";

/**
 * User-facing copy for the active browser sign-in step, shared by the Settings
 * Account tab and the app-wide session-expired banner so the two stay in sync.
 * Only the in-flight statuses (`opening_browser` → `awaiting_redirect` →
 * `exchanging`) are distinguished; any other status falls back to the opening
 * copy, which covers the brief tick before the browser launch resolves.
 */
export function signInPendingMessage(status: DesktopAuthStatus): string {
  switch (status) {
    case "exchanging":
      return "Finishing sign-in...";
    case "awaiting_redirect":
      return "Waiting for you to finish in your browser...";
    default:
      return "Opening your browser...";
  }
}
