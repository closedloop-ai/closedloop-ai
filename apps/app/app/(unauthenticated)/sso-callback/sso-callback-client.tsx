"use client";

import type { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { AuthTransitionPanel } from "@repo/app/onboarding/components/auth-transition-panel";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { AuthenticateWithRedirectCallback } from "@repo/auth/client";
import { ClerkCaptchaMount } from "@repo/auth/components/clerk-captcha-mount";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { useEffect, useState } from "react";
import {
  AuthTransitionLeg,
  HANDSHAKE_FAILURE_TITLE,
  HANDSHAKE_WAITING_TITLE,
  REQUEST_UNANSWERED_DESCRIPTION,
  STILL_WAITING_DESCRIPTION,
} from "@/lib/auth-transition-copy";
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
  /**
   * The destination for the SIGN-UP arm of the handshake — the
   * already-validated target. Forced only for that arm; the sign-in arm keeps
   * the flow's own `redirectUrl`. Absent when no trusted destination rode in,
   * which forces nothing.
   */
  readonly signUpRedirectUrl?: string;
};

/**
 * The leg this screen waits on, and the only one it can enter. Unlike the
 * sibling `/connect/github`, it is outstanding from mount: Clerk's callback
 * component starts the handshake as soon as it renders, so this screen has no
 * pre-flight phase in which the ceiling could legitimately end the wait.
 */
const SCREEN_LEG = AuthTransitionLeg.Handshake;

const HandshakePhase = {
  /** Clerk's callback is working and has not navigated away. */
  InFlight: "in_flight",
  /**
   * Outstanding past the shared ceiling: the message escalated and the way out
   * appeared. Still a wait, because nothing here observed an outcome.
   */
  Stalled: "stalled",
  /** The in-flight bound expired with the handshake still outstanding. */
  Unanswered: "unanswered",
} as const;
type HandshakePhase = (typeof HandshakePhase)[keyof typeof HandshakePhase];

/**
 * Completes the OAuth handshake started by `signIn.sso` on `/connect/github`.
 *
 * ISS-10913: the sign-UP arm is FORCED to a marked copy of the same
 * destination, which is how the desktop learns that this attempt created an
 * account rather than authenticating an existing one. Only that arm is forced,
 * and only when a trusted destination rode in — the sign-in arm and every
 * skewed callback keep the flow's own `redirectUrl` exactly as before.
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
 *
 * What that ceiling may SAY is the ISS-10564 half. Clerk's callback reports
 * nothing either way, so reaching ten seconds is not evidence the handshake was
 * refused — it is evidence no answer has arrived. The ceiling therefore
 * escalates the message and offers the way out while keeping the waiting state;
 * only the handshake's own longer bound, where the page genuinely stops
 * waiting, may say the sign-in did not finish.
 */
export function SsoCallbackClient({
  fallbackRedirectUrl,
  fallbackSignInHref,
  provider,
  signUpRedirectUrl,
}: SsoCallbackClientProps) {
  const [phase, setPhase] = useState<HandshakePhase>(HandshakePhase.InFlight);
  const label = DESKTOP_SIGN_IN_PROVIDER_LABEL[provider];

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setPhase((previous) =>
        previous === HandshakePhase.InFlight ? HandshakePhase.Stalled : previous
      );
    }, AUTH_TRANSITION_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  }, []);

  // The handshake's own bound, and the only thing that may state a failure
  // here. Clerk's callback carries no deadline of its own, so without this the
  // stalled panel would wait forever. The same 60s the shared API client
  // applies to its own requests, anchored on mount because that is when this
  // leg starts.
  useEffect(() => {
    const timeoutId = setTimeout(
      () => setPhase(HandshakePhase.Unanswered),
      DEFAULT_API_TIMEOUT_MS
    );
    return () => clearTimeout(timeoutId);
  }, []);

  // `outline` while the handshake is still running, solid once the page has
  // stopped waiting: the button's weight tracks how sure the screen is.
  const recoveryAction = (variant: "default" | "outline") => (
    <Button asChild className="w-full" variant={variant}>
      <Link href={fallbackSignInHref}>Continue to sign in</Link>
    </Button>
  );

  return (
    <>
      {/* Stays mounted past both bounds ON PURPOSE. Clerk navigates away the
          moment the handshake lands, so unmounting it would abort a slow but
          working handshake and strand the user for real. The recovery link
          below is an escape hatch, not a cancellation — whichever finishes
          first wins. */}
      <AuthenticateWithRedirectCallback
        signInFallbackRedirectUrl={fallbackRedirectUrl}
        signUpFallbackRedirectUrl={fallbackRedirectUrl}
        signUpForceRedirectUrl={signUpRedirectUrl}
      />
      {/* ISS-11429: mounted for the SIGN-UP arm above. Clerk transfers a
          sign-in to a sign-up when the provider account has no Closedloop user
          yet, and that arm runs bot protection, which needs this element to
          already exist. Without it Clerk downgrades to its invisible widget and
          says so — measured on `/sso-callback` on the prod host. */}
      <ClerkCaptchaMount />
      {phase === HandshakePhase.Unanswered ? (
        <AuthTransitionPanel
          action={recoveryAction("default")}
          description={REQUEST_UNANSWERED_DESCRIPTION[SCREEN_LEG](label)}
          provider={provider}
          title={HANDSHAKE_FAILURE_TITLE}
        />
      ) : (
        <AuthTransitionPanel
          action={
            phase === HandshakePhase.Stalled
              ? recoveryAction("outline")
              : undefined
          }
          busy
          description={
            phase === HandshakePhase.Stalled
              ? STILL_WAITING_DESCRIPTION[SCREEN_LEG](label)
              : undefined
          }
          provider={provider}
          title={HANDSHAKE_WAITING_TITLE}
        />
      )}
    </>
  );
}
