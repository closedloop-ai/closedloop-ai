import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useCallback, useState } from "react";
import { useDesktopAuth } from "../shared-agent-sessions/desktop-auth-provider";
import { signInPendingMessage } from "../shared-agent-sessions/desktop-sign-in-copy";

/**
 * App-wide recovery prompt for an involuntary desktop sign-out (FEA-2219).
 *
 * When the first-party session can no longer be renewed, the main-process
 * manager lands in `refresh_failed` and every cloud surface (Insights,
 * Branches, …) silently stops loading because each gates on `authenticated`.
 * This banner surfaces that condition globally — not just buried in Settings →
 * Account — with a one-click re-auth so the user can restore cloud data, then
 * hides once signed back in.
 *
 * No separate feature-flag check is needed at mount: `refresh_failed` is only
 * reachable once a first-party session has existed, and creating that session is
 * itself gated behind `desktopFirstPartyAuthEnabled`. Gating on the (already
 * typed) `useDesktopAuth()` state therefore keeps the banner dark wherever the
 * feature is off, without reaching into the untyped settings blob.
 *
 * The one residual edge is the flag being turned off *after* a session existed
 * and then expiring: the banner still latches, but re-auth is now gated off at
 * the IPC boundary (FEA-2687) and returns `{ ok: false, reason: "unavailable" }`.
 * `handleSignIn` detects that terminal result and dismisses the banner rather
 * than stranding the user on a dead "Sign in" button.
 */
export function DesktopSessionExpiredBanner() {
  const { state, beginSignIn, cancelSignIn } = useDesktopAuth();
  const [signingIn, setSigningIn] = useState(false);

  // Latch the prompt once the session drops to `refresh_failed`, and keep it up
  // until the user is authenticated again. A failed or cancelled re-auth lands
  // the manager in `signed_out` (not back in `refresh_failed`), so keying purely
  // on the live status would let one dismissal defeat the recovery prompt. This
  // is the "adjust state during render" pattern — no effect, converges in one
  // pass (each branch flips the flag it just checked).
  const [needsReauth, setNeedsReauth] = useState(false);
  if (state.status === "refresh_failed" && !needsReauth) {
    setNeedsReauth(true);
  } else if (state.status === "authenticated" && needsReauth) {
    setNeedsReauth(false);
  }

  const handleSignIn = useCallback(async () => {
    // Local flag (not the global status) scopes the banner's progress view to a
    // re-auth started here — a sign-in launched from Settings doesn't light it up.
    setSigningIn(true);
    try {
      const result = await beginSignIn();
      // Flag-off-after-session: re-auth is gated off at the IPC boundary
      // (FEA-2687), so this recovery can never succeed. Drop the latch to hide
      // the banner instead of leaving a dead "Sign in" button. Other failures
      // are retryable, so keep the banner up for those.
      if (!result.ok && result.reason === "unavailable") {
        setNeedsReauth(false);
      }
    } finally {
      setSigningIn(false);
    }
  }, [beginSignIn]);

  const handleCancel = useCallback(() => {
    // Best-effort; the pushed main-process state is the source of truth. Cancel
    // stops the in-flight sign-in and returns to the prompt (the latch persists).
    cancelSignIn().catch(() => undefined);
  }, [cancelSignIn]);

  if (!needsReauth) {
    return null;
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center gap-3 border-b bg-[var(--destructive)]/10 px-4 py-2 text-[var(--foreground)] text-sm"
      role="status"
    >
      <span className="truncate">
        {signingIn
          ? signInPendingMessage(state.status)
          : "Your session expired. Sign in to reconnect and load your data."}
      </span>
      {signingIn ? (
        <Button onClick={handleCancel} size="sm" variant="ghost">
          Cancel
        </Button>
      ) : (
        <Button onClick={handleSignIn} size="sm" variant="default">
          Sign in
        </Button>
      )}
    </div>
  );
}
