"use client";

import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import type {
  ConnectGitHubResponse,
  GitHubClerkLinkClientFailureReport,
  GitHubClerkLinkSyncResponse,
} from "@repo/api/src/types/github";
import {
  GitHubAccessDenialReason as GitHubAccessDenialReasonValue,
  GitHubClerkLinkClientFailureStage,
} from "@repo/api/src/types/github";
import {
  GITHUB_CLERK_OAUTH_SCOPES,
  GITHUB_CLERK_RELINK_ATTEMPTED_PARAM,
} from "@repo/api/src/types/github-clerk-link";
import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import { AuthTransitionPanel } from "@repo/app/onboarding/components/auth-transition-panel";
import { DEFAULT_API_TIMEOUT_MS } from "@repo/app/shared/api/api-timeout";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { CLERK_OAUTH_STRATEGY } from "@repo/app/shared/lib/clerk-oauth-strategy";
import { useClerk, useReverification, useUser } from "@repo/auth/client";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getCanonicalBranchViewReturnPath } from "@/app/api/integrations/github/github-return-path";
import {
  AUTH_TRANSITION_TIMEOUT_MS,
  buildSignInFallbackHref,
} from "@/lib/github-connect-redirect";
import { reportClientFailure } from "../report-client-failure";
import {
  ClerkLinkVerificationError,
  classifyLinkThrow,
} from "./clerk-error-classification";
import {
  GENERIC_FAILURE_DESCRIPTION,
  LINK_FAILURE_DESCRIPTION,
  PendingLeg,
  PREFLIGHT_TIMEOUT_DESCRIPTION,
  REQUEST_UNANSWERED_DESCRIPTION,
  RESUME_CLAIM_FAILURE_DESCRIPTION,
  STILL_CONNECTING_DESCRIPTION,
} from "./link-failure-copy";

type ClerkGitHubLinkClientProps = {
  /**
   * Same-origin path to land on once linking completes. Already validated by
   * `getCanonicalBranchViewReturnPath` on the server — this component does
   * not re-validate, and must never be handed a raw query value.
   */
  readonly returnToPath: string;
  /**
   * This page's own URL (path + preserved raw `returnTo`), built server-side.
   * The signed-out fallback signs in TO here so the connect resumes — sending
   * the user to `returnToPath` instead would land them signed in but still
   * unconnected, with nothing saying the link never happened.
   */
  readonly resumePath: string;
  /**
   * An installed-but-unclaimed GitHub App installation handed over by the
   * install callback (PLN-1742 M5), already digits-validated on the server.
   * When present, a successful link finishes that claim here so the user
   * lands connected rather than being told to install again.
   */
  readonly resumeInstallationId: string | null;
};

const LinkFlowPhase = {
  /** Waiting for Clerk's client to load, or for the attempt to be started. */
  Preflight: "preflight",
  /** A request to Clerk or to `/integrations/github/clerk-link` is outstanding. */
  InFlight: "in_flight",
  /**
   * Outstanding past the pre-flight ceiling: the message escalated and nothing
   * else. The in-flight bound still ends it if the request never settles.
   */
  Stalled: "stalled",
  SignInRequired: "sign_in_required",
  Failed: "failed",
} as const;

type LinkFlow =
  | { readonly phase: typeof LinkFlowPhase.Preflight }
  | {
      readonly phase: typeof LinkFlowPhase.InFlight;
      readonly leg: PendingLeg;
    }
  | {
      readonly phase: typeof LinkFlowPhase.Stalled;
      readonly leg: PendingLeg;
    }
  | { readonly phase: typeof LinkFlowPhase.SignInRequired }
  | {
      readonly phase: typeof LinkFlowPhase.Failed;
      readonly description: string;
    };

// Singletons rather than a fresh literal per transition: a structurally-equal
// object is never `Object.is`-equal, so setting a phase the flow is already in
// would re-render instead of bailing out, and `useApiClient()` hands the start
// effect a fresh dependency on every one of those renders.
const PREFLIGHT_FLOW: LinkFlow = { phase: LinkFlowPhase.Preflight };
const SIGN_IN_REQUIRED_FLOW: LinkFlow = {
  phase: LinkFlowPhase.SignInRequired,
};
const PREFLIGHT_TIMEOUT_FLOW: LinkFlow = {
  phase: LinkFlowPhase.Failed,
  description: PREFLIGHT_TIMEOUT_DESCRIPTION,
};

// One singleton per leg, for the same Object.is reason — and as exhaustive
// `Record<PendingLeg, …>`s, so adding a leg fails `tsc` at every place that
// has to know about it rather than at none of them (ISS-10411).
const IN_FLIGHT_FLOW: Record<PendingLeg, LinkFlow> = {
  [PendingLeg.GitHub]: {
    phase: LinkFlowPhase.InFlight,
    leg: PendingLeg.GitHub,
  },
  [PendingLeg.ServerSync]: {
    phase: LinkFlowPhase.InFlight,
    leg: PendingLeg.ServerSync,
  },
};
const STALLED_FLOW: Record<PendingLeg, LinkFlow> = {
  [PendingLeg.GitHub]: { phase: LinkFlowPhase.Stalled, leg: PendingLeg.GitHub },
  [PendingLeg.ServerSync]: {
    phase: LinkFlowPhase.Stalled,
    leg: PendingLeg.ServerSync,
  },
};
const REQUEST_UNANSWERED_FLOW: Record<PendingLeg, LinkFlow> = {
  [PendingLeg.GitHub]: {
    phase: LinkFlowPhase.Failed,
    description: REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.GitHub],
  },
  [PendingLeg.ServerSync]: {
    phase: LinkFlowPhase.Failed,
    description: REQUEST_UNANSWERED_DESCRIPTION[PendingLeg.ServerSync],
  },
};

/**
 * Drives Clerk's external-account linking on mount (PLN-1742 M3):
 * `user.createExternalAccount({ strategy: "oauth_github" })` → GitHub
 * authorize → back here → `POST /integrations/github/clerk-link` (so the
 * token-less registry row exists before any status surface re-reads) →
 * `returnTo` with the same `?github=connected` marker the install callback
 * appends, so the return-notice banners keep working unchanged.
 *
 * An effect is the right tool for the same reason as the sibling
 * `GitHubConnectRedirectClient`: the triggering click happened on another
 * surface, and nothing can start until Clerk's client has loaded. The ref
 * guard keeps StrictMode's double-invoke from starting two flows.
 */
export function ClerkGitHubLinkClient({
  resumeInstallationId,
  returnToPath,
  resumePath,
}: ClerkGitHubLinkClientProps) {
  const { isLoaded, user } = useUser();
  const clerk = useClerk();
  /**
   * ISS-11315: the two Clerk SSO-connection calls this routine makes, each
   * wrapped so a session Clerk considers stale is RE-VERIFIED and the call
   * retried, instead of rejecting with `session_reverification_required`.
   *
   * Measured in production on 2026-09-27: four `github_clerk_link_failed`
   * records, every one `clerkErrorCode=session_reverification_required`,
   * `stage=threw` — the operator's click and his retries. The code is not in
   * `CLERK_LINK_ERROR_DESCRIPTION`, so it fell through to the leg sentence and
   * the panel offered "Try again", which re-ran the same unwrapped call into
   * the same refusal. Reverification is Clerk's documented requirement for
   * managing SSO connections (its own `manage-sso-connections` custom flow
   * wraps exactly these two calls), so the defect was calling them raw — not
   * an instance misconfiguration.
   *
   * The default `useReverification` behaviour is deliberate: Clerk renders its
   * OWN verification prompt and retries the original call on success, so the
   * recovery path adds no Closedloop-authored copy and cannot drift from what
   * Clerk asks for. A user who DISMISSES it gets
   * {@link REVERIFICATION_CANCELLED_DESCRIPTION}, whose "Try again" reaches a
   * prompt that can succeed — not the leg sentence, which says only that the
   * round trip did not complete and never why.
   */
  const createExternalAccountReverified = useReverification(
    (
      target: NonNullable<typeof user>,
      params: Parameters<NonNullable<typeof user>["createExternalAccount"]>[0]
    ) => target.createExternalAccount(params)
  );
  const destroyExternalAccountReverified = useReverification(
    (account: NonNullable<typeof user>["externalAccounts"][number]) =>
      account.destroy()
  );
  /**
   * The THIRD SSO-connection mutation, and the one that decides whether
   * `session_reverification_required` can still reach the catch below.
   *
   * `useReverification` does not RETHROW that code — `resolveResult` catches it
   * and returns a reverification HINT instead
   * (`@clerk/shared@4.8.3` `dist/runtime/react/index.mjs:1908`), which is why
   * the recognised-code entry for it was deleted. That reasoning only holds if
   * every call that can raise it is wrapped, and this one was not: a raw
   * `reauthorize()` rejection propagates unchanged. Wrapped so the deletion is
   * sound rather than probably-sound, and because leaving one SSO-connection
   * mutation raw is the same defect its two siblings were just fixed for.
   */
  const reauthorizeExternalAccountReverified = useReverification(
    (
      account: NonNullable<typeof user>["externalAccounts"][number],
      params: Parameters<
        NonNullable<typeof user>["externalAccounts"][number]["reauthorize"]
      >[0]
    ) => account.reauthorize(params)
  );
  const apiClient = useApiClient();
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<LinkFlow>(PREFLIGHT_FLOW);
  const startedRef = useRef(false);
  const retryAttemptRef = useRef<number | null>(null);
  // ISS-10411: which attempt a continuation belongs to. The in-flight ceiling
  // below sets a terminal state but cancels nothing, so the Clerk calls and the
  // POSTs it gave up on can still settle afterwards — navigating the user away
  // on a success the panel already denied, or rewriting the terminal copy under
  // them. The ceiling retires the attempt; every post-await side effect checks
  // its own attempt is still the live one before acting.
  const attemptRef = useRef(0);
  // Leaving the route retires the attempt for the same reason: an unmount
  // cancels nothing either, so a Clerk call or POST still outstanding could
  // settle afterwards and pull the user back to `returnTo` from wherever they
  // navigated. A flag rather than an `attemptRef` bump because StrictMode's
  // mount/unmount/mount would spend that bump on the live attempt.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Stall ceiling, same as the sibling transition routes and for the same
  // shipped reason (`AUTH_TRANSITION_TIMEOUT_MS`'s docstring): if Clerk's
  // client never settles, flip to the failure panel with its recovery
  // actions instead of an indefinite spinner.
  //
  // ISS-10411: it may only do that BEFORE a request is outstanding. Flipping a
  // live request to Failed is what told a user their working connection had
  // been "interrupted", then navigated them away on the success it denied, so
  // once one is in flight this ceiling escalates the message and nothing more.
  // The in-flight phase is bounded separately, by the effect below.
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setFlow((previous) => {
        if (previous.phase === LinkFlowPhase.Preflight) {
          return PREFLIGHT_TIMEOUT_FLOW;
        }
        if (previous.phase === LinkFlowPhase.InFlight) {
          return STALLED_FLOW[previous.leg];
        }
        return previous;
      });
    }, AUTH_TRANSITION_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  }, []);

  // The in-flight phase's own bound, and the only thing that ends it short of
  // the request settling. Of the calls `startLink` awaits, only
  // `apiClient.post` carries `DEFAULT_API_TIMEOUT_MS`: `createExternalAccount`,
  // `reauthorize` and `destroy` are Clerk SDK calls the shared client never
  // sees, and nothing else bounds them — so a hung Clerk call on the
  // first-ever link would otherwise hold the spinner forever with no way out,
  // which is the defect the pre-flight ceiling exists to prevent. The same 60s
  // the shared client would have applied, anchored on entering the phase rather
  // than on mount, so escalating InFlight → Stalled does not restart it.
  //
  // The dependency is the LEG rather than a boolean, which keeps that same
  // no-restart property: the leg is chosen once, before the first await, so
  // escalating InFlight → Stalled carries the same value through and the
  // effect does not re-run. It is also what the expiry sentence needs to name.
  const pendingLeg =
    flow.phase === LinkFlowPhase.InFlight ||
    flow.phase === LinkFlowPhase.Stalled
      ? flow.leg
      : null;
  useEffect(() => {
    if (!pendingLeg) {
      return;
    }
    const timeoutId = setTimeout(() => {
      attemptRef.current += 1;
      setFlow(REQUEST_UNANSWERED_FLOW[pendingLeg]);
    }, DEFAULT_API_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  }, [pendingLeg]);

  useEffect(() => {
    // Preflight only. The ceiling above can terminate the flow while Clerk is
    // still loading, and a late `isLoaded` flip must not revive that failure
    // panel into a spinner the user never asked for.
    if (
      !isLoaded ||
      startedRef.current ||
      flow.phase !== LinkFlowPhase.Preflight
    ) {
      return;
    }
    startedRef.current = true;

    if (!user) {
      setFlow(SIGN_IN_REQUIRED_FLOW);
      return;
    }

    // Which leg this attempt will wait on, decided BEFORE the first await so
    // every stall and expiry sentence below can name it (ISS-10411). A verified
    // account means GitHub has already answered and the registry sync is the
    // only round trip left; anything else starts at the authorize hand-off.
    // It cannot change mid-mount: the hand-off ends by navigating to GitHub,
    // and the sync leg is reached on the fresh mount after the return.
    const existingGitHubAccount = user.externalAccounts.find(
      (account) => account.provider === "github"
    );
    const leg =
      existingGitHubAccount?.verification?.status === "verified"
        ? PendingLeg.ServerSync
        : PendingLeg.GitHub;

    setFlow(IN_FLIGHT_FLOW[leg]);
    const attempt = attemptRef.current;
    const isCurrentAttempt = () =>
      mountedRef.current && attemptRef.current === attempt;
    const navigateIfCurrent = (href: string) => {
      if (isCurrentAttempt()) {
        window.location.assign(href);
      }
    };

    // Deliberately does NOT reopen `startedRef`. ISS-10411: "Retry must retain
    // the initiating desktop return target and not duplicate or lose the
    // connection attempt." Reopening it let the start effect run again on the
    // next render — `useApiClient()` supplies a fresh dependency every time —
    // so a single refusal re-issued the link POST behind a failure screen the
    // user had not acted on. Measured on this suite: two POSTs per failure
    // before this change. The recovery path is the panel's "Try again", which
    // reloads the page and starts a genuinely new attempt.
    const fail = (description: string) => {
      if (!isCurrentAttempt()) {
        return;
      }
      setFlow({ phase: LinkFlowPhase.Failed, description });
    };

    // ISS-11244: the reporting twin of `fail`, behind the SAME attempt guard.
    // A report is a post-await side effect like every other one in this effect,
    // so it owes the ceiling the same deference: without the guard, a request
    // the in-flight deadline already retired — and already told the user we had
    // stopped waiting for — would emit a second, codeless failure record for one
    // failure, and a report could fire after the user left the route.
    const failAndReport = (
      description: string,
      report: GitHubClerkLinkClientFailureReport
    ) => {
      if (!isCurrentAttempt()) {
        return;
      }
      fail(description);
      reportClientFailure(apiClient, report);
    };

    const finishLink = async (
      verifiedAccount: (typeof user.externalAccounts)[number],
      resolvedReturnToPath: string
    ) => {
      const relinkAttempted = new URLSearchParams(window.location.search).has(
        GITHUB_CLERK_RELINK_ATTEMPTED_PARAM
      );
      const result = await apiClient.post<GitHubClerkLinkSyncResponse>(
        buildLinkRequestPath(relinkAttempted),
        {}
      );
      if (result.linked) {
        const linkedFailure = await completeLinkedFlow({
          apiClient,
          navigate: navigateIfCurrent,
          queryClient,
          resumeInstallationId,
          returnToPath: resolvedReturnToPath,
        });
        if (linkedFailure) {
          fail(linkedFailure);
        }
        return;
      }
      // PLN-1742 M5 re-link: Clerk cannot widen an existing grant silently,
      // so a verified account whose grant lacks `repo` is routed through
      // GitHub's consent screen once. The marker param stops a denied or
      // still-narrow consent from looping back into a second attempt.
      if (
        result.reason === GitHubAccessDenialReasonValue.InsufficientScope &&
        !relinkAttempted
      ) {
        const relinkReturn = new URL(window.location.href);
        relinkReturn.searchParams.set(GITHUB_CLERK_RELINK_ATTEMPTED_PARAM, "1");
        const reauthorized = await reauthorizeExternalAccountReverified(
          verifiedAccount,
          {
            additionalScopes: [...GITHUB_CLERK_OAUTH_SCOPES],
            redirectUrl: relinkReturn.toString(),
          }
        );
        const reauthorizeUrl =
          reauthorized.verification?.externalVerificationRedirectURL;
        if (reauthorizeUrl) {
          navigateIfCurrent(reauthorizeUrl.href);
          return;
        }
        // ISS-11244: `reauthorize()` resolved without a consent URL, so the
        // page has nowhere to send the user and falls back to the denial it
        // already holds. That denial is `insufficient_scope` BEFORE consent,
        // which the API deliberately does not record (`isPreConsentScopeWidening`)
        // because before consent it is normally a step inside a link that then
        // succeeds — so this genuinely terminal state was the one denial
        // leaving no artifact on either side. The sentence is the shipped
        // `insufficient_scope` one, unchanged: the fallback below would render
        // exactly it, and what the page learned here is not something the
        // reader can act on differently.
        failAndReport(
          LINK_FAILURE_DESCRIPTION[
            GitHubAccessDenialReasonValue.InsufficientScope
          ],
          { stage: GitHubClerkLinkClientFailureStage.ReauthorizeNoConsentUrl }
        );
        return;
      }
      if (result.reason) {
        fail(LINK_FAILURE_DESCRIPTION[result.reason]);
        return;
      }
      // The other unrecognised shape: a refusal carrying no reason, which the
      // wire vocabulary says should not happen. The denial half of
      // `github_clerk_link_failed` never fires for it, because the server
      // believed it had answered (ISS-11244).
      failAndReport(GENERIC_FAILURE_DESCRIPTION, {
        stage: GitHubClerkLinkClientFailureStage.SyncNoReason,
      });
    };

    const startLink = async () => {
      const existing = existingGitHubAccount;
      if (existing && existing.verification?.status === "verified") {
        const resolvedReturnToPath = await resolveLinkReturnPath(
          clerk,
          user,
          returnToPath,
          isCurrentAttempt
        );
        if (isCurrentAttempt()) {
          await finishLink(existing, resolvedReturnToPath);
        }
        return;
      }
      // ISS-12627 AC1-3: a returned refusal is terminal until the user retries.
      if (existing?.verification?.error) {
        throw new ClerkLinkVerificationError(existing.verification.error);
      }
      // Clear an unverified attempt only when Clerk reported no callback error.
      // Verified narrow-scope accounts re-link in place through finishLink (M5).
      if (existing) {
        await destroyExternalAccountReverified(existing);
      }
      // Named on the FIRST link too, not just the M5 re-link below, so both
      // paths ask for one set and a fresh grant matches a re-linked one.
      // `additionalScopes` is additive to the Clerk Dashboard's GitHub provider
      // config, so it can only widen: dropping `read:org` from what the consent
      // screen shows a first-time linker is the dashboard's half of ISS-8156.
      // `user` passed as an ARGUMENT rather than closed over (ISS-11315
      // review): a wrapper reading the nullable `user` from scope returns
      // `undefined` when it is null, and that `undefined` then reaches the
      // no-redirect arm below and is reported as `HandoffNoRedirect` — the same
      // record Clerk answering without a redirect URL produces. The early
      // `if (!user)` guard above makes that unreachable today, but the optional
      // chain enforced no such invariant, so a guard that later drifts would
      // silently report "we never called Clerk" as "Clerk answered
      // ambiguously". Taking the narrowed user as a parameter removes
      // `undefined` from the return type instead of relying on a distant guard.
      const created = await createExternalAccountReverified(user, {
        additionalScopes: [...GITHUB_CLERK_OAUTH_SCOPES],
        strategy: CLERK_OAUTH_STRATEGY[DesktopSignInProvider.GitHub],
        redirectUrl: window.location.href,
      });
      const verificationUrl =
        created.verification?.externalVerificationRedirectURL;
      if (!verificationUrl) {
        // A genuinely unrecognised shape: Clerk resolved without refusing and
        // without a redirect URL to send the user to. ISS-11244 — reported so
        // the residue arm is diagnosable rather than silent.
        failAndReport(GENERIC_FAILURE_DESCRIPTION, {
          stage: GitHubClerkLinkClientFailureStage.HandoffNoRedirect,
        });
        return;
      }
      navigateIfCurrent(verificationUrl.href);
    };

    // ISS-11244: inspect the throw instead of discarding it. The bare
    // `.catch(() => fail(GENERIC_FAILURE_DESCRIPTION))` this replaces rendered
    // the unrecognised-shape sentence for every refusal in the routine —
    // `existing.destroy()`, `createExternalAccount()`, the link POST — and
    // emitted nothing, so neither the user nor an operator could tell which
    // round trip refused. The classified sentence names the leg; the Clerk code
    // goes to the monitor, which is the only place it can be read from.
    startLink().catch((error: unknown) => {
      const classified = classifyLinkThrow(error, leg);
      failAndReport(classified.description, classified.report);
    });
  }, [
    apiClient,
    clerk,
    createExternalAccountReverified,
    destroyExternalAccountReverified,
    reauthorizeExternalAccountReverified,
    flow.phase,
    isLoaded,
    queryClient,
    resumeInstallationId,
    returnToPath,
    user,
  ]);

  // ISS-12627 AC4: only the explicit retry may discard a failed callback.
  const retryLink = async () => {
    if (retryAttemptRef.current === attemptRef.current) {
      return;
    }
    const attempt = ++attemptRef.current;
    retryAttemptRef.current = attempt;
    const isCurrentAttempt = () =>
      mountedRef.current && attemptRef.current === attempt;
    try {
      const failedAccount = user?.externalAccounts.find(
        (account) =>
          account.provider === "github" && account.verification?.error
      );
      if (failedAccount) {
        setFlow(IN_FLIGHT_FLOW[PendingLeg.GitHub]);
        await destroyExternalAccountReverified(failedAccount);
      }
      if (isCurrentAttempt()) {
        window.location.assign(buildRetryHref());
      }
    } catch (error: unknown) {
      if (isCurrentAttempt()) {
        const classified = classifyLinkThrow(error, PendingLeg.GitHub);
        setFlow({
          phase: LinkFlowPhase.Failed,
          description: classified.description,
        });
        reportClientFailure(apiClient, classified.report);
      }
    } finally {
      if (retryAttemptRef.current === attempt) {
        retryAttemptRef.current = null;
      }
    }
  };

  if (flow.phase === LinkFlowPhase.SignInRequired) {
    return (
      <AuthTransitionPanel
        action={
          <Button asChild className="w-full">
            <Link href={buildSignInFallbackHref(resumePath)}>
              Continue to sign in
            </Link>
          </Button>
        }
        description="Sign in to your Closedloop account first, then connect GitHub."
        provider={DesktopSignInProvider.GitHub}
        title="Sign in to connect GitHub"
      />
    );
  }

  if (flow.phase === LinkFlowPhase.Failed) {
    return (
      <AuthTransitionPanel
        action={
          <Button className="w-full" onClick={retryLink} type="button">
            Try again
          </Button>
        }
        description={flow.description}
        provider={DesktopSignInProvider.GitHub}
        title="We couldn't connect GitHub"
      />
    );
  }

  return (
    <AuthTransitionPanel
      busy
      description={
        flow.phase === LinkFlowPhase.Stalled
          ? STILL_CONNECTING_DESCRIPTION[flow.leg]
          : undefined
      }
      provider={DesktopSignInProvider.GitHub}
      title="Connecting your GitHub account"
    />
  );
}

/**
 * The linked half of the flow: finish an install callback's pending claim if
 * one was handed over, then leave for `returnTo` with the same
 * `?github=connected` marker the install callback appends. Returns a failure
 * description, or null once `navigate` has been handed the return URL.
 */
async function completeLinkedFlow(input: {
  apiClient: ReturnType<typeof useApiClient>;
  navigate: (href: string) => void;
  queryClient: ReturnType<typeof useQueryClient>;
  resumeInstallationId: string | null;
  returnToPath: string;
}): Promise<string | null> {
  if (input.resumeInstallationId) {
    const claimed = await claimPendingInstallation(
      input.apiClient,
      input.resumeInstallationId
    );
    if (!claimed) {
      return RESUME_CLAIM_FAILURE_DESCRIPTION;
    }
  }
  await input.queryClient.invalidateQueries({ queryKey: githubKeys.all });
  const returnUrl = new URL(input.returnToPath, window.location.origin);
  returnUrl.searchParams.set("github", GitHubConnectReturnStatus.Connected);
  input.navigate(`${returnUrl.pathname}${returnUrl.search}`);
  return null;
}

async function claimPendingInstallation(
  apiClient: ReturnType<typeof useApiClient>,
  installationId: string
): Promise<boolean> {
  try {
    await apiClient.post<ConnectGitHubResponse>(
      "/integrations/github/connect",
      { installationId }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The retry target for the failure panel: this URL with the re-link marker
 * dropped. A plain reload would keep `relink=1`, which is exactly what stops
 * the automatic loop — so the user would be offered a "try again" that
 * provably could not reach GitHub's consent screen again. `returnTo` is
 * preserved, so a retry still lands where the desktop asked it to
 * (ISS-10411).
 */
function buildRetryHref(): string {
  const retryUrl = new URL(window.location.href);
  retryUrl.searchParams.delete(GITHUB_CLERK_RELINK_ATTEMPTED_PARAM);
  return `${retryUrl.pathname}${retryUrl.search}`;
}

/**
 * ISS-10459: a caller that has already been through GitHub's consent screen
 * says so, because the server's failure record cannot otherwise tell a
 * terminal `insufficient_scope` from the benign one `finishLink` answers by
 * re-linking. Unmarked on the first attempt, so that request is unchanged.
 */
function buildLinkRequestPath(relinkAttempted: boolean): string {
  const marker = relinkAttempted
    ? `?${GITHUB_CLERK_RELINK_ATTEMPTED_PARAM}=1`
    : "";
  return `/integrations/github/clerk-link${marker}`;
}

/** Desktop-created organizations do not activate the user's browser session. */
async function activateSoleLinkOrganization(
  clerk: ReturnType<typeof useClerk>,
  user: NonNullable<ReturnType<typeof useUser>["user"]>,
  isCurrentAttempt: () => boolean
): Promise<string | null> {
  if (clerk.session?.lastActiveOrganizationId) {
    return null;
  }
  const memberships = await user.getOrganizationMemberships({ pageSize: 2 });
  // Only one membership is unambiguous. Never choose an arbitrary tenant.
  if (
    !isCurrentAttempt() ||
    memberships.total_count !== 1 ||
    memberships.data.length !== 1
  ) {
    return null;
  }
  const organization = memberships.data[0].organization;
  await clerk.setActive({ organization: organization.id });
  return organization.slug;
}

async function resolveLinkReturnPath(
  clerk: ReturnType<typeof useClerk>,
  user: NonNullable<ReturnType<typeof useUser>["user"]>,
  returnToPath: string,
  isCurrentAttempt: () => boolean
): Promise<string> {
  const organizationSlug = await activateSoleLinkOrganization(
    clerk,
    user,
    isCurrentAttempt
  );
  if (!organizationSlug) {
    return returnToPath;
  }
  return (
    getCanonicalBranchViewReturnPath(
      new URLSearchParams(window.location.search).get("returnTo"),
      { orgSlug: organizationSlug }
    ) ?? returnToPath
  );
}
