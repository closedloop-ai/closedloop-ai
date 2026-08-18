import type {
  DesktopAuthStatus,
  DesktopBrowserSignInFailure,
} from "../types/desktop-api";

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

/**
 * User-facing, secret-free message for a begin-sign-in FAILURE reason, shared by
 * the Settings Account tab and the Sessions KPI-card sign-in CTA (FEA-3574
 * review) so a failed browser sign-in surfaces the same retryable copy wherever
 * it is triggered. `cancelled` is intentionally NOT mapped — callers treat an
 * explicit cancel as a non-error and suppress it before reaching here.
 */
export function signInFailureMessage(
  reason: DesktopBrowserSignInFailure
): string {
  switch (reason) {
    case "start_failed":
      // Not a network failure — this is a local setup issue (e.g. keystore /
      // signing-key or loopback listener). Don't misdirect users to their
      // connection; the underlying cause is captured in the app diagnostics log.
      return "Couldn't start sign-in. Please try again — restart the app if it keeps failing.";
    case "open_failed":
      return "Couldn't open your browser. Try again.";
    case "redirect_timeout":
      return "Sign-in timed out waiting for your browser. Try again.";
    case "state_mismatch":
      return "The sign-in response failed a security check. Try again.";
    case "expired":
      return "The sign-in request expired. Try again.";
    case "exchange_failed":
      return "Sign-in completed but credentials couldn't be established. Try again.";
    case "already_in_progress":
      return "A sign-in is already in progress.";
    default:
      return "Sign-in isn't available right now. Try again.";
  }
}
