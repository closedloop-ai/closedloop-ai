import type {
  DesktopAuthStatus,
  DesktopBrowserSignInFailure,
} from "../types/desktop-api";

/**
 * User-facing copy for the active browser sign-in step, read by the app-wide
 * session-expired banner.
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
 * User-facing, secret-free message for a begin-sign-in FAILURE reason, read
 * through `useDesktopSignIn` (FEA-3574 review) so a failed browser sign-in
 * surfaces the same retryable copy wherever it is triggered. `cancelled` is intentionally NOT mapped — callers treat an
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

/**
 * ISS-11345: the account confirmation a confirmation-gated sign-in shows before
 * it adopts the browser's session. `title` and `confirmLabel` are Marisol
 * Ashgrove's copy (ISS-11345 v3, 2026-09-28), which adds no description
 * sentence: the User and Organization rows are the dialog's description.
 * `cancelLabel` reuses the "Cancel" the pending sign-in row already ships.
 */
export const DESKTOP_SIGN_IN_ACCOUNT_CONFIRM_COPY = {
  title: "Connect with this account?",
  confirmLabel: "Confirm",
  cancelLabel: "Cancel",
} as const;
