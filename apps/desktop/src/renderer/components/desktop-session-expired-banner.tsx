import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { useCallback, useRef, useState } from "react";
import {
  CloudSocketDegradedReason,
  CloudSocketError,
} from "../../shared/cloud-socket-error";
import { CloudStatusKind, useCloudStatus } from "../hooks/use-cloud-status";
import { useDesktopAuth } from "../shared-agent-sessions/desktop-auth-provider";
import { signInPendingMessage } from "../shared-agent-sessions/desktop-sign-in-copy";
import type { DesktopAuthStatus } from "../types/desktop-api";

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
 * reachable once a first-party session has existed. Gating on the (already
 * typed) `useDesktopAuth()` state keeps the banner dark until a session has
 * existed, without reaching into the untyped settings blob.
 *
 * If the auth bridge is absent (a partial test stub), re-auth resolves to
 * `{ ok: false, reason: "unavailable" }`. `handleSignIn` detects that terminal
 * result and dismisses the banner rather than stranding the user on a dead
 * "Sign in" button.
 *
 * ISS-11843: the same prompt routes a device whose handshake the cloud refuses
 * to the Connect (authorize) flow. Operator rulings, Marisol Ashgrove 2026-10-05:
 * the copy is "unable to connect to server", and an account change gets a new
 * gateway identity. Sign-out is where the desktop mints that identity, so the
 * action signs out before it opens Connect.
 */
export function DesktopSessionExpiredBanner() {
  const { state, beginSignIn, cancelSignIn, signOut } = useDesktopAuth();
  const [signingIn, setSigningIn] = useState(false);
  const cloudStatus = useCloudStatus(true);
  const handshakeRefused =
    state.status === "authenticated" &&
    cloudStatus?.kind === CloudStatusKind.Degraded &&
    cloudStatus.reason === CloudSocketDegradedReason.HandshakeRefused;

  // Latch the prompt once the session drops to `refresh_failed` (or the
  // handshake is refused), and keep it up until the user is authenticated with
  // a connection the cloud accepts. A failed or cancelled re-auth lands the
  // manager in `signed_out`, so keying purely on the live status would let one
  // dismissal defeat the recovery prompt. This is the "adjust state during
  // render" pattern — no effect, converges in one pass.
  const [prompt, setPrompt] = useState<BannerPrompt | null>(null);
  // Whether the signed-out state is one this banner's own reconnect produced.
  // A cancelled or failed reconnect leaves the user signed out by this banner's
  // click, so the refused prompt must stay up for them to retry.
  const [ownSignOut, setOwnSignOut] = useState(false);
  if (
    ownSignOut &&
    state.status === "authenticated" &&
    !handshakeRefused &&
    !signingIn
  ) {
    setOwnSignOut(false);
  }
  // Cancel can land while sign-out is still settling (it waits on loop
  // cleanup), before there is a sign-in for `cancelSignIn` to stop.
  const cancelRequested = useRef(false);
  const nextPrompt = resolveBannerPrompt(
    state.status,
    handshakeRefused,
    prompt,
    signingIn || ownSignOut
  );
  if (nextPrompt !== prompt) {
    setPrompt(nextPrompt);
  }

  const handleSignIn = useCallback(async () => {
    // Local flag (not the global status) scopes the banner's progress view to a
    // re-auth started here — a sign-in launched from Settings doesn't light it up.
    setSigningIn(true);
    cancelRequested.current = false;
    try {
      if (prompt === BannerPrompt.HandshakeRefused) {
        setOwnSignOut(true);
        // Sign-out can reject after it already signed the account out (its
        // local cleanup failed). Sign-in is still attempted: it refuses on its
        // own while a session remains, which leaves the prompt up to retry.
        await signOut().catch(() => undefined);
        if (cancelRequested.current) {
          return;
        }
      }
      const result = await beginSignIn();
      // Bridge/manager unavailable: with the first-party-auth gate retired
      // (FEA-4133), `reason: "unavailable"` now means the auth bridge or session
      // manager is genuinely unavailable (e.g. a partial test stub), so this
      // recovery can never succeed. Drop the latch to hide the banner instead of
      // leaving a dead "Sign in" button. Other failures are retryable, so keep
      // the banner up for those.
      if (!result.ok && result.reason === "unavailable") {
        setPrompt(null);
      }
    } finally {
      setSigningIn(false);
    }
  }, [beginSignIn, prompt, signOut]);

  const handleCancel = useCallback(() => {
    // Best-effort; the pushed main-process state is the source of truth. Cancel
    // stops the in-flight sign-in and returns to the prompt (the latch persists).
    cancelRequested.current = true;
    cancelSignIn().catch(() => undefined);
  }, [cancelSignIn]);

  if (prompt === null) {
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
          : BANNER_PROMPT_MESSAGE[prompt]}
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

const BannerPrompt = {
  SessionExpired: "session_expired",
  HandshakeRefused: "handshake_refused",
} as const;
type BannerPrompt = (typeof BannerPrompt)[keyof typeof BannerPrompt];

const BANNER_PROMPT_MESSAGE: Record<BannerPrompt, string> = {
  [BannerPrompt.SessionExpired]:
    "Your session expired. Sign in to reconnect and load your data.",
  [BannerPrompt.HandshakeRefused]: CloudSocketError.HandshakeRefused,
};

function resolveBannerPrompt(
  status: DesktopAuthStatus,
  handshakeRefused: boolean,
  latched: BannerPrompt | null,
  ownReconnect: boolean
): BannerPrompt | null {
  if (status === "refresh_failed") {
    return BannerPrompt.SessionExpired;
  }
  if (handshakeRefused) {
    return BannerPrompt.HandshakeRefused;
  }
  if (status === "authenticated") {
    return null;
  }
  // The refused prompt outlives a sign-out only when the banner's own
  // reconnect did it; a sign-out from anywhere else ends it.
  if (latched === BannerPrompt.HandshakeRefused && !ownReconnect) {
    return null;
  }
  return latched;
}
