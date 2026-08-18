"use client";

import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  DesktopSignInProvider,
} from "@repo/api/src/types/desktop-authorize-url";
import { AuthTransitionPanel } from "@repo/app/onboarding/components/auth-transition-panel";
import { useClerk, useSignIn } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { useEffect, useRef, useState } from "react";
import {
  AUTH_TRANSITION_TIMEOUT_MS,
  DESKTOP_SIGN_IN_PROVIDER_LABEL,
} from "@/lib/github-connect-redirect";

/** Route that completes the OAuth handshake before landing on the target. */
const SSO_CALLBACK_PATH = "/sso-callback";

/**
 * The handshake route, carrying the provider forward.
 *
 * `/sso-callback` is the NEXT stop in this same flow and it stalls on the same
 * 10s ceiling, so without this it would tell a Google user to "pick GitHub to
 * finish connecting" — the wrong-door bug this route exists to fix, one screen
 * later. Clerk builds its OAuth `redirect_uri` from this value and appends its
 * own params, so an existing query string rides along.
 *
 * Degrades to today's behavior if it does not: the callback page defaults an
 * absent provider to GitHub, which is what that screen already showed.
 */
function buildSsoCallbackPath(provider: DesktopSignInProvider): string {
  return `${SSO_CALLBACK_PATH}?${DESKTOP_AUTHORIZE_QUERY_PARAMS.provider}=${provider}`;
}

/**
 * Clerk strategy id per social connection. Exhaustive over
 * {@link DesktopSignInProvider}, so adding a provider fails `tsc` here rather
 * than silently falling back to somebody else's login.
 */
const OAUTH_STRATEGY = {
  [DesktopSignInProvider.GitHub]: "oauth_github",
  [DesktopSignInProvider.Google]: "oauth_google",
} as const satisfies Record<DesktopSignInProvider, string>;

type GitHubConnectRedirectClientProps = {
  /**
   * Same-origin path to land on once authentication completes. Already
   * validated by `resolveGitHubConnectRedirectTarget` on the server — this
   * component does not re-validate, and must never be handed a raw query value.
   */
  readonly redirectUrlComplete: string;
  /** Where to send the user if the automatic redirect cannot be started. */
  readonly fallbackSignInHref: string;
  /**
   * Which provider the user already picked in the desktop app. Already narrowed
   * to a known value by the page, which defaults it to GitHub.
   */
  readonly provider: DesktopSignInProvider;
};

/**
 * Fires the social OAuth redirect on mount so the first thing a signed-out user
 * sees after pressing GitHub or Google in the desktop app is that provider's own
 * authorize screen — not a chooser asking them the question they just answered.
 *
 * `provider` is what makes the two buttons differ (ISS-5112). Before it, this
 * route started GitHub unconditionally, so picking Google in the desktop landed
 * on GitHub's consent screen.
 *
 * Uses `signIn.sso` (rather than `signUp.sso`) deliberately: Clerk transfers to
 * a sign-up when the GitHub account has no Closedloop user yet, so one entry
 * point serves both new and returning users. `/sso-callback` completes
 * whichever branch Clerk chose.
 *
 * NOTE on the param names — Clerk v7's future API INVERTS the v5 meanings, and
 * the two are easy to swap by accident:
 *   - `redirectUrl`         → where the user finally lands (v5: redirectUrlComplete)
 *   - `redirectCallbackUrl` → the SSO handshake route      (v5: redirectUrl)
 * Getting these backwards strands the desktop on its loopback listener until it
 * times out, with no error surfaced anywhere.
 *
 * An effect is the right tool here even under this app's "you might not need an
 * Effect" rule: the triggering user action happened in another process (the
 * desktop click), and the redirect cannot fire until Clerk's client has loaded.
 * The ref guard keeps StrictMode's double-invoke from starting two flows.
 */
export function GitHubConnectRedirectClient({
  redirectUrlComplete,
  fallbackSignInHref,
  provider,
}: GitHubConnectRedirectClientProps) {
  const { signIn } = useSignIn();
  const { loaded } = useClerk();
  const [failed, setFailed] = useState(false);
  const startedRef = useRef(false);

  // Runs on mount and is deliberately independent of whether `sso()` ever
  // fired, so a Clerk client that never loads still reaches the failure state.
  useEffect(() => {
    const timeoutId = setTimeout(
      () => setFailed(true),
      AUTH_TRANSITION_TIMEOUT_MS
    );
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!(loaded && signIn) || startedRef.current) {
      return;
    }
    startedRef.current = true;

    // `sso()` reports failure as a VALUE (`{ error }`) rather than throwing, but
    // a transport failure can still reject — both paths surface the manual
    // fallback, and both reset the guard so a remount can retry.
    const fail = () => {
      startedRef.current = false;
      setFailed(true);
    };

    signIn
      .sso({
        strategy: OAUTH_STRATEGY[provider],
        redirectUrl: redirectUrlComplete,
        redirectCallbackUrl: buildSsoCallbackPath(provider),
      })
      .then((result) => {
        if (result?.error) {
          fail();
        }
      })
      .catch(fail);
  }, [loaded, signIn, redirectUrlComplete, provider]);

  const label = DESKTOP_SIGN_IN_PROVIDER_LABEL[provider];

  if (failed) {
    // Keeps the mark: the user pressed this provider's button in another app, so
    // the mark is the cue for WHICH hop broke — and dropping it here would shift
    // the whole block upward at the moment the copy changes, turning a copy swap
    // into a relayout.
    return (
      <AuthTransitionPanel
        action={
          <Button asChild className="w-full">
            <Link href={fallbackSignInHref}>Continue to sign in</Link>
          </Button>
        }
        description={`Your desktop app is still waiting. Sign in and pick ${label} to finish connecting.`}
        provider={provider}
        title={`We couldn't open ${label}`}
      />
    );
  }

  return (
    <AuthTransitionPanel
      busy
      provider={provider}
      title={`Taking you to ${label}`}
    />
  );
}
