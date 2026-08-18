"use client";

import {
  AuthRejectionReason,
  clearAuthRejection,
  getAuthRejectionReason,
  isIdentityProbeAuthRejection,
  subscribeAuthRejection,
} from "@repo/app/shared/query/auth-rejection-store";
import { useCurrentUser, userKeys } from "@repo/app/users/hooks/use-users";
import { useClerk } from "@repo/auth/client";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useState,
  useSyncExternalStore,
} from "react";

const SIGN_IN_PATH = "/sign-in";

type WorkspaceAuthGuardProps = {
  readonly children: ReactNode;
};

/**
 * Web-shell degraded state for a bricked authenticated session (FEA-3940).
 *
 * When an authenticated API request fails with an auth error (401/403) — Clerk
 * token rotation losing the race, a failed refresh, a deploy rejecting an
 * in-flight token, an expired session — the app used to render a blank white
 * main region with no way out. This guard instead surfaces a real "session
 * expired" recovery state (DS `Alert`, `role="alert"`) with a **Sign in** and a
 * **Retry** action, keeping the left-nav chrome intact.
 *
 * The trip signal comes from two places so a session that breaks *after* `/me`
 * last succeeded is still caught: the guard directly observes the canonical
 * `/me` query, and it subscribes to the shared auth-rejection store, which the
 * `QueryCache.onError` boundary in `makeQueryClient` publishes to on the first
 * 401 from *any* query. `/me` alone is insufficient — it stays fresh for five
 * minutes and the shared client disables focus/reconnect refetches, so on its
 * own it would never re-run to notice a later break.
 *
 * The two signals accept deliberately different status codes (ISS-5095). `/me`
 * trips on 401 *or* 403 because it is the identity probe — a 403 answering "who
 * am I" means the session cannot be established. Every other query trips on a
 * 401, or on a response the server explicitly tagged with an `AuthErrorCode`: a
 * BARE 403 there means one specific resource is not yours, which must render
 * that surface's own error state rather than replacing the whole workspace with
 * a false "Your session expired".
 *
 * The card then says WHICH failure happened, and offers only the recoveries that
 * can actually fix it — see `AUTH_REJECTION_COPY`. A denied organization is not
 * an expired session, and an organization we could not reach Clerk to check
 * (ISS-5118) is neither; asserting "Your session expired" over a live session,
 * or offering a Sign in that destroys a working session to no effect, is the
 * same class of false claim this surface exists to remove.
 *
 * Scope: the web shell only. The desktop renderer has its own first-party
 * session recovery (`DesktopSessionExpiredBanner`), so this stays out of the
 * shared `@repo/app` package. Copy is kept in step with that banner so a user
 * who hits both surfaces reads one voice.
 *
 * Only a persistent *auth* failure trips the guard. A transient network error
 * (no HTTP response) or a non-auth API error falls through to the normal shell
 * so per-page error/empty states handle it — this guard is specifically the
 * "you can't reach Closedloop because you're not authenticated" surface.
 */
export function WorkspaceAuthGuard({ children }: WorkspaceAuthGuardProps) {
  const queryClient = useQueryClient();
  const { signOut } = useClerk();
  // Local sign-out failure state: the only recovery action must not silently
  // do nothing if Clerk rejects `signOut`. On failure we surface a message and
  // keep the user on the card (they can still Retry) instead of a dead button.
  const [signOutFailed, setSignOutFailed] = useState(false);
  const { error, isError } = useCurrentUser({
    // Auth failures are terminal, not transient: fail fast so the recovery
    // surface appears immediately instead of after retry backoff. (The shared
    // client already skips retries on 4xx/5xx; this is explicit at the guard.)
    retry: false,
  });

  // Any query's session rejection (not just `/me`) latches this via the shared
  // boundary: a 401, or a 403 the server tagged session-level. A bare 403 does
  // not (ISS-5095) — see `classifyAuthRejection`. The reason comes with it, so
  // the card can say what actually happened rather than assert an expired
  // session over an organization that merely could not be confirmed.
  const crossQueryRejectionReason = useSyncExternalStore(
    subscribeAuthRejection,
    getAuthRejectionReason,
    // Server snapshot: no auth rejection has been observed during SSR.
    getServerAuthRejectionReason
  );

  const handleRetry = useCallback(() => {
    // A fresh `/me` fetch is the recovery probe; clear the latched cross-query
    // signal so a recovered session drops the surface, and reset any prior
    // sign-out failure so its message doesn't linger.
    setSignOutFailed(false);
    clearAuthRejection();
    queryClient.invalidateQueries({ queryKey: userKeys.currentUser() });
  }, [queryClient]);

  const handleSignIn = useCallback(() => {
    setSignOutFailed(false);
    // Clear the poisoned session so the sign-in flow starts clean, then land
    // back on the sign-in route. If Clerk rejects the sign-out the redirect
    // never happens, so surface that so the user isn't stranded on a button
    // that appears to do nothing.
    signOut({ redirectUrl: SIGN_IN_PATH }).catch(() => {
      setSignOutFailed(true);
    });
  }, [signOut]);

  const copy = resolveAuthFailureCopy(
    isError ? error : null,
    crossQueryRejectionReason
  );

  if (!copy) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-full flex-1 items-center justify-center p-6">
      <Alert className="max-w-md" variant="error">
        <AlertCircleIcon />
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>
          <p>{copy.description}</p>
          {signOutFailed ? (
            <p className="mt-2">
              We couldn't start the sign-in flow. Retry, or reload the page and
              try again.
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            {/* Order, emphasis, and PRESENCE all follow the copy: the card must
                not name one action as the likely fix and then present the other
                one first, and it must not offer an action that cannot work for
                the failure it just described. */}
            {copy.actions.map((action, index) => (
              <Button
                key={action}
                onClick={
                  action === AuthFailureAction.Retry
                    ? handleRetry
                    : handleSignIn
                }
                size="sm"
                variant={index === 0 ? "default" : "outline"}
              >
                {AUTH_FAILURE_ACTION_LABELS[action]}
              </Button>
            ))}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}

/** A recovery this card can offer. */
const AuthFailureAction = {
  SignIn: "sign-in",
  Retry: "retry",
} as const;
type AuthFailureAction =
  (typeof AuthFailureAction)[keyof typeof AuthFailureAction];

/** Button label per action, so no copy entry can invent its own wording. */
const AUTH_FAILURE_ACTION_LABELS: Record<AuthFailureAction, string> = {
  [AuthFailureAction.SignIn]: "Sign in",
  [AuthFailureAction.Retry]: "Retry",
};

type AuthFailureCopy = {
  title: string;
  description: string;
  /**
   * The recoveries to offer, most-likely-fix first. A LIST rather than a
   * "primary" flag because for some failures the right answer is that the other
   * action is not offered at all: an action the copy has just explained cannot
   * work is an invitation to make things worse.
   */
  actions: readonly AuthFailureAction[];
};

/**
 * Recovery copy for a session that is not valid: a 401 from any query, or an
 * auth failure on `/me`, the identity probe (FEA-3940). The wording matches
 * `DesktopSessionExpiredBanner` ("Your session expired. Sign in to reconnect…")
 * so the web and desktop surfaces speak with one voice, and it names the real
 * state plainly (the session isn't valid) rather than selling Retry as the
 * likely fix — Retry only recovers the narrow deploy-rejected-an-in-flight-token
 * case; Sign in is the fix for a genuinely expired session.
 */
const SESSION_EXPIRED_COPY: AuthFailureCopy = {
  title: "Your session expired",
  description:
    "Sign in to reconnect and load your data. Retry only if this was a brief interruption.",
  actions: [AuthFailureAction.SignIn, AuthFailureAction.Retry],
};

/**
 * Recovery copy for `AuthErrorCode.OrgForbidden` (ISS-5095). This user's session
 * is intact — the server asked Clerk and was told this caller is not a member of
 * the organization the request named, which is an org switch that raced or a
 * membership changed mid-session. (A lookup that FAILED is not this case since
 * ISS-5118; that is `OrgUnverifiable` and gets `ORG_UNVERIFIABLE_COPY` below.)
 * "Your session expired" would be a false statement about a live session, and it
 * leads with the wrong action: Retry is the likely fix for the race, so this
 * copy leads with Retry and keeps Sign in as the fallback for the membership
 * case, which is the reverse of the order above.
 */
const ORG_UNCONFIRMED_COPY: AuthFailureCopy = {
  title: "We couldn't confirm your organization",
  description:
    "Your organization access may have changed, or the switch didn't finish. Retry to reload it, or sign in again if that doesn't clear it.",
  actions: [AuthFailureAction.Retry, AuthFailureAction.SignIn],
};

/**
 * Recovery copy for `AuthErrorCode.OrgUnverifiable` (ISS-5118). The server did
 * not decide anything here: the identity-provider lookup FAILED, so nothing
 * about this user's access is known. That rules out both of the other cards —
 * the session is not expired, and the organization was not refused — and it
 * rules out Sign in as an action, because signing in again cannot resolve a
 * provider outage and destroys a working session to find that out. So this is
 * the one card with a single recovery.
 *
 * It exists at all because the condition is page-wide: the org header rides
 * every authenticated request, so the outage fails every query at once. Without
 * a shell state the user is left with a wall of repeated widget errors, or a
 * blank main region on the surfaces that cannot render without `/me` — the
 * blank workspace FEA-3940 exists to prevent, arriving through another door.
 */
const ORG_UNVERIFIABLE_COPY: AuthFailureCopy = {
  title: "We couldn't check your organization",
  description:
    "This is on our side, not yours — your access hasn't changed. Try again in a moment.",
  actions: [AuthFailureAction.Retry],
};

/**
 * The card for each latched reason. Exhaustive by construction: a new
 * {@link AuthRejectionReason} fails typecheck here rather than falling through
 * to the shell rendering a dead workspace with no explanation.
 */
const AUTH_REJECTION_COPY: Record<AuthRejectionReason, AuthFailureCopy> = {
  [AuthRejectionReason.SessionExpired]: SESSION_EXPIRED_COPY,
  [AuthRejectionReason.OrgUnconfirmed]: ORG_UNCONFIRMED_COPY,
  [AuthRejectionReason.OrgUnverifiable]: ORG_UNVERIFIABLE_COPY,
};

/** SSR snapshot for the cross-query auth-rejection store. */
function getServerAuthRejectionReason(): AuthRejectionReason | null {
  return null;
}

/**
 * Map the guard's inputs to recovery copy, or `null` when the shell should
 * render normally. Trips on either a direct `/me` auth error (401/403) or a
 * cross-query auth rejection latched by the shared boundary; any other `/me`
 * error (transient network, non-auth API error) falls through so per-page
 * states handle it. Keeping the trip condition and its copy in one place stops
 * them from drifting apart.
 */
function resolveAuthFailureCopy(
  error: unknown,
  crossQueryRejectionReason: AuthRejectionReason | null
): AuthFailureCopy | null {
  if (crossQueryRejectionReason !== null) {
    return AUTH_REJECTION_COPY[crossQueryRejectionReason];
  }
  // The `/me` branch: 401 or 403, coded or not. Read from the shared store
  // rather than re-derived here, so the identity-probe rule and the cross-query
  // rule cannot drift apart (they are deliberately different, and the whole
  // ISS-5095 bug was one status test standing in for two questions).
  if (isIdentityProbeAuthRejection(error)) {
    return SESSION_EXPIRED_COPY;
  }
  return null;
}
