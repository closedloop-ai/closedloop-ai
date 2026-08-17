"use client";

import type { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { AuthTransitionPanel } from "@repo/app/onboarding/components/auth-transition-panel";
import { AuthenticateWithRedirectCallback } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { useEffect, useState } from "react";
import {
  AUTH_TRANSITION_TIMEOUT_MS,
  DESKTOP_SIGN_IN_PROVIDER_LABEL,
} from "@/lib/github-connect-redirect";

type SsoCallbackClientProps = {
  /** Same-origin path to land on when Clerk cannot infer one from the flow. */
  readonly fallbackRedirectUrl: string;
  /** Where to send the user if the handshake never completes. */
  readonly fallbackSignInHref: string;
  /**
   * Which provider the user picked back on `/connect/github`. Names the brand
   * mark and the recovery copy, so a Google user is not told to pick GitHub.
   */
  readonly provider: DesktopSignInProvider;
};

/**
 * Completes the OAuth handshake started by `signIn.sso` on `/connect/github`.
 *
 * `<AuthenticateWithRedirectCallback />` owns the branch logic Clerk documents
 * for custom flows — transferring a sign-in to a sign-up when the GitHub
 * account has no Closedloop user yet, and vice versa — so this route serves
 * first-time and returning users identically without hand-rolling the transfer
 * state machine.
 *
 * Shares {@link AuthTransitionPanel} with `/connect/github`: this is the same
 * "hold on, we're moving you" moment two steps later, and it should not look
 * like a different product.
 *
 * It also shares the ceiling, which it originally did not. Clerk's callback
 * component navigates on success and surfaces nothing on a stall, so without a
 * timeout this screen spun forever — the UI insisting something was happening
 * when nothing was. That is worse here than on the sibling route, not better:
 * this is the LATER stop, so by the time it stalls the user has already spent
 * the whole GitHub round trip and their desktop app is sitting on a loopback
 * listener waiting for a callback that is not coming.
 */
export function SsoCallbackClient({
  fallbackRedirectUrl,
  fallbackSignInHref,
  provider,
}: SsoCallbackClientProps) {
  const [stalled, setStalled] = useState(false);
  const label = DESKTOP_SIGN_IN_PROVIDER_LABEL[provider];

  useEffect(() => {
    const timeoutId = setTimeout(
      () => setStalled(true),
      AUTH_TRANSITION_TIMEOUT_MS
    );
    return () => clearTimeout(timeoutId);
  }, []);

  return (
    <>
      {/* Stays mounted past the ceiling ON PURPOSE. Clerk navigates away the
          moment the handshake lands, so unmounting it at 10s would abort a slow
          but working handshake and strand the user for real. The recovery link
          below is an escape hatch, not a cancellation — whichever finishes
          first wins. */}
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl={fallbackRedirectUrl}
        signUpFallbackRedirectUrl={fallbackRedirectUrl}
      />
      {stalled ? (
        <AuthTransitionPanel
          action={
            <Button asChild className="w-full">
              <Link href={fallbackSignInHref}>Continue to sign in</Link>
            </Button>
          }
          description={`Your desktop app is still waiting. Sign in and pick ${label} to finish connecting.`}
          provider={provider}
          title="We couldn't finish signing you in"
        />
      ) : (
        <AuthTransitionPanel
          busy
          provider={provider}
          title="Finishing sign-in"
        />
      )}
    </>
  );
}
