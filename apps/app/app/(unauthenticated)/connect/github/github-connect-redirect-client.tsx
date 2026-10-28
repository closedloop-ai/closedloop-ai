"use client";

import {
  DESKTOP_AUTHORIZE_QUERY_PARAMS,
  type DesktopSignInProvider,
} from "@repo/api/src/types/desktop-authorize-url";
import { AuthTransitionPanel } from "@repo/app/onboarding/components/auth-transition-panel";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { CLERK_OAUTH_STRATEGY } from "@repo/app/shared/lib/clerk-oauth-strategy";
import { useClerk, useSignIn } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import {
  AuthTransitionLeg,
  HANDOFF_NEVER_STARTED_DESCRIPTION,
  HANDOFF_REFUSED_DESCRIPTION,
  handoffFailureTitle,
  handoffWaitingTitle,
  REQUEST_UNANSWERED_DESCRIPTION,
  STILL_WAITING_DESCRIPTION,
} from "@/lib/auth-transition-copy";
import {
  AUTH_TRANSITION_TIMEOUT_MS,
  DESKTOP_SIGN_IN_PROVIDER_LABEL,
  GITHUB_CONNECT_REDIRECT_PARAM,
} from "@/lib/github-connect-redirect";
import { reportClientFailure } from "./report-client-failure";
import { classifySsoRefusal } from "./sso-refusal-classification";

/** Route that completes the OAuth handshake before landing on the target. */
const SSO_CALLBACK_PATH = "/sso-callback";

/**
 * The handshake route, carrying the provider and the destination forward.
 *
 * `/sso-callback` is the NEXT stop in this same flow and it stalls on the same
 * 10s ceiling, so without the provider it would tell a Google user to "pick
 * GitHub to finish connecting" — the wrong-door bug this route exists to fix,
 * one screen later. Clerk builds its OAuth `redirect_uri` from this value and
 * appends its own params, so an existing query string rides along.
 *
 * ISS-10913 adds the destination. Clerk carries `redirectUrl` through the
 * handshake itself, so the callback never needed it to LAND anywhere — but it
 * does need it to mark the sign-UP arm, which is the only evidence the desktop
 * gets that this attempt created an account. Passing the already-validated
 * target means that page composes the marked URL from a same-origin path
 * rather than from a raw query value.
 *
 * Degrades to today's behavior if either is lost: the callback page defaults an
 * absent provider to GitHub, and an absent destination leaves the sign-up arm
 * unmarked, which reads downstream as "no creation observed".
 */
function buildSsoCallbackPath(
  provider: DesktopSignInProvider,
  redirectUrlComplete: string
): string {
  const params = new URLSearchParams({
    [DESKTOP_AUTHORIZE_QUERY_PARAMS.provider]: provider,
    [GITHUB_CONNECT_REDIRECT_PARAM]: redirectUrlComplete,
  });
  return `${SSO_CALLBACK_PATH}?${params.toString()}`;
}

/**
 * The leg this screen waits on, and the only one it can enter: `signIn.sso`
 * opening the provider's authorize screen.
 */
const SCREEN_LEG = AuthTransitionLeg.ProviderHandoff;

const RedirectPhase = {
  /** Clerk's client has not loaded, so nothing is outstanding yet. */
  Preflight: "preflight",
  /** `signIn.sso` is in flight. */
  InFlight: "in_flight",
  /**
   * Outstanding past the shared ceiling: the message escalated and nothing
   * else. The in-flight bound below still ends it if `sso` never settles.
   */
  Stalled: "stalled",
  Failed: "failed",
} as const;

/**
 * Why the screen stopped. ISS-10564: kept apart because only one of these is an
 * observed refusal, and the ceiling reaches the other two knowing nothing about
 * what the provider did.
 */
const RedirectFailure = {
  /** The ceiling expired with nothing outstanding: `sso` never ran. */
  NeverStarted: "never_started",
  /** `sso` reported an error value or rejected. */
  Refused: "refused",
  /** The in-flight bound expired with `sso` still outstanding. */
  Unanswered: "unanswered",
} as const;
type RedirectFailure = (typeof RedirectFailure)[keyof typeof RedirectFailure];

type RedirectFlow =
  | { readonly phase: typeof RedirectPhase.Preflight }
  | {
      readonly phase: typeof RedirectPhase.InFlight;
      readonly leg: AuthTransitionLeg;
    }
  | {
      readonly phase: typeof RedirectPhase.Stalled;
      readonly leg: AuthTransitionLeg;
    }
  | {
      readonly phase: typeof RedirectPhase.Failed;
      readonly failure: RedirectFailure;
    };

// Singletons rather than a fresh literal per transition: a structurally-equal
// object is never `Object.is`-equal, so setting a phase the flow is already in
// would re-render instead of bailing out, and the start effect below takes a
// fresh `signIn` object on every one of those renders.
const PREFLIGHT_FLOW: RedirectFlow = { phase: RedirectPhase.Preflight };
const IN_FLIGHT_FLOW: RedirectFlow = {
  phase: RedirectPhase.InFlight,
  leg: SCREEN_LEG,
};
const STALLED_FLOW: RedirectFlow = {
  phase: RedirectPhase.Stalled,
  leg: SCREEN_LEG,
};
const NEVER_STARTED_FLOW: RedirectFlow = {
  phase: RedirectPhase.Failed,
  failure: RedirectFailure.NeverStarted,
};
const REFUSED_FLOW: RedirectFlow = {
  phase: RedirectPhase.Failed,
  failure: RedirectFailure.Refused,
};
const UNANSWERED_FLOW: RedirectFlow = {
  phase: RedirectPhase.Failed,
  failure: RedirectFailure.Unanswered,
};

/** Exhaustive over {@link RedirectFailure}: a new reason fails `tsc` here. */
const FAILURE_DESCRIPTION: Record<
  RedirectFailure,
  (providerLabel: string) => string
> = {
  [RedirectFailure.NeverStarted]: HANDOFF_NEVER_STARTED_DESCRIPTION,
  [RedirectFailure.Refused]: HANDOFF_REFUSED_DESCRIPTION,
  [RedirectFailure.Unanswered]: REQUEST_UNANSWERED_DESCRIPTION[SCREEN_LEG],
};

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
  const apiClient = useApiClient();
  const [flow, setFlow] = useState<RedirectFlow>(PREFLIGHT_FLOW);
  const startedRef = useRef(false);
  // Which attempt a continuation belongs to. The in-flight bound below sets a
  // terminal state but cancels nothing, so the `sso()` call it gave up on can
  // still settle afterwards and rewrite "we stopped waiting" into a refusal the
  // page never observed. The bound retires the attempt; `fail` checks its own
  // attempt is still the live one before acting. Same guard as the sibling
  // link screen (`link/clerk-github-link-client.tsx`).
  const attemptRef = useRef(0);

  // Runs on mount and is deliberately independent of whether `sso()` ever
  // fired, so a Clerk client that never loads still reaches a stated end.
  //
  // ISS-10564: it may only END the wait while nothing is outstanding. Reaching
  // this ceiling with `sso()` in flight told a user on the desktop journey that
  // the provider step had refused them, when all the page knew was that no
  // answer had arrived in ten seconds — so from there it escalates the message
  // and nothing more. The in-flight phase is bounded separately, below.
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setFlow((previous) => {
        if (previous.phase === RedirectPhase.Preflight) {
          return NEVER_STARTED_FLOW;
        }
        if (previous.phase === RedirectPhase.InFlight) {
          return STALLED_FLOW;
        }
        return previous;
      });
    }, AUTH_TRANSITION_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  }, []);

  // The in-flight phase's own bound, and the only thing that ends it short of
  // `sso()` settling. Nothing else bounds that call: it is a Clerk SDK call the
  // shared API client never sees, so a hung hand-off would otherwise hold the
  // stalled panel forever — the indefinite spinner the ceiling exists to
  // prevent, one phase along. The same 60s the shared client applies to its own
  // requests, anchored on entering the phase rather than on mount so escalating
  // InFlight -> Stalled does not restart it: the leg is fixed for the mount, so
  // that transition carries the same dependency value through.
  const pendingLeg =
    flow.phase === RedirectPhase.InFlight ||
    flow.phase === RedirectPhase.Stalled
      ? flow.leg
      : null;
  useEffect(() => {
    if (!pendingLeg) {
      return;
    }
    const timeoutId = setTimeout(() => {
      attemptRef.current += 1;
      setFlow(UNANSWERED_FLOW);
    }, DEFAULT_API_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  }, [pendingLeg]);

  useEffect(() => {
    // Pre-flight only. The ceiling above can end the wait while Clerk is still
    // loading, and a late `loaded` flip must not revive that panel into a
    // spinner — or hand the browser to the provider out from under a user who
    // has already been offered, and may already have taken, the way out.
    if (
      !(loaded && signIn) ||
      startedRef.current ||
      flow.phase !== RedirectPhase.Preflight
    ) {
      return;
    }
    startedRef.current = true;
    setFlow(IN_FLIGHT_FLOW);
    const attempt = attemptRef.current;

    // `sso()` reports failure as a VALUE (`{ error }`) rather than throwing, but
    // a transport failure can still reject — both paths are an OBSERVED refusal,
    // and both reset the guard so a remount can retry.
    //
    // ISS-11315: the refusal is CLASSIFIED AND REPORTED rather than discarded.
    // `fail` took no argument before this, so the one fact that names which
    // refusal happened — Clerk's `errors[].code` — was dropped on the floor on
    // both paths, and a hand-off that locks a new user out of GitHub sign-up
    // left no artifact anywhere. Same remedy, same monitor and same helper as
    // the sibling signed-in link leg (ISS-11244); what the user is TOLD is
    // unchanged, because the page still knows only that the hand-off was
    // refused and must not claim a cause it merely recorded.
    const fail = (error: unknown) => {
      if (attemptRef.current !== attempt) {
        return;
      }
      startedRef.current = false;
      reportClientFailure(apiClient, classifySsoRefusal(error));
      setFlow(REFUSED_FLOW);
    };

    signIn
      .sso({
        strategy: CLERK_OAUTH_STRATEGY[provider],
        redirectUrl: redirectUrlComplete,
        redirectCallbackUrl: buildSsoCallbackPath(
          provider,
          redirectUrlComplete
        ),
      })
      .then((result) => {
        if (result?.error) {
          fail(result.error);
        }
      })
      .catch(fail);
  }, [loaded, signIn, redirectUrlComplete, provider, flow.phase, apiClient]);

  const label = DESKTOP_SIGN_IN_PROVIDER_LABEL[provider];
  // ISS-10564 (review): the two bounds above retire the ATTEMPT, which is all
  // this page controls — a late `{ error }` or rejection can no longer rewrite
  // the panel into a refusal it never observed. They cannot retire `sso()`
  // itself. Clerk owns that redirect INTERNALLY: `SignInFutureSSOParams` offers
  // no navigate hook and no abort signal, so unlike the sibling link screen —
  // where `createExternalAccount` hands the URL back and the component
  // navigates under its own attempt guard — there is no URL here to withhold,
  // and a hand-off that finally answers calls `window.location.assign` from
  // inside the SDK whatever this page has since said.
  //
  // So LEAVING is the half that has to be terminal. A soft route change keeps
  // this document, and that still-pending call, alive: the user who took the
  // offered way out gets pulled off `/sign-in` and into the provider anyway,
  // mid-sign-in, by a request the screen already told them it had given up on.
  // A full document load ends the context that holds it.
  const leaveForSignIn = (event: MouseEvent<HTMLAnchorElement>) => {
    if (opensElsewhere(event)) {
      return;
    }
    event.preventDefault();
    window.location.assign(fallbackSignInHref);
  };
  // `outline` while the page is still working, solid once it has stopped: a
  // full-width primary CTA under a live spinner competes with it for what the
  // user should do, and the button's weight should track how sure the screen is.
  const recoveryAction = (variant: "default" | "outline") => (
    <Button asChild className="w-full" variant={variant}>
      <Link href={fallbackSignInHref} onClick={leaveForSignIn}>
        Continue to sign in
      </Link>
    </Button>
  );

  if (flow.phase === RedirectPhase.Failed) {
    // Keeps the mark: the user pressed this provider's button in another app, so
    // the mark is the cue for WHICH hop broke — and dropping it here would shift
    // the whole block upward at the moment the copy changes, turning a copy swap
    // into a relayout.
    return (
      <AuthTransitionPanel
        action={recoveryAction("default")}
        description={FAILURE_DESCRIPTION[flow.failure](label)}
        provider={provider}
        title={handoffFailureTitle(label)}
      />
    );
  }

  const stalled = flow.phase === RedirectPhase.Stalled;
  return (
    <AuthTransitionPanel
      // The way out stays offered from the ceiling onward, as it was before
      // ISS-10564 — the escalation may correct what the screen CLAIMS, never
      // withdraw the affordance the user already had at that moment.
      action={stalled ? recoveryAction("outline") : undefined}
      busy
      description={
        stalled ? STILL_WAITING_DESCRIPTION[flow.leg](label) : undefined
      }
      provider={provider}
      title={handoffWaitingTitle(label)}
    />
  );
}

/**
 * Whether the browser's own handling already takes the user somewhere other
 * than this document — a new tab, a new window, a download.
 *
 * Those must keep the default: they leave this document standing, so there is
 * nothing to tear down, and hijacking them into a same-tab load would take the
 * page away from a user who deliberately asked to keep it.
 */
function opensElsewhere(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}
