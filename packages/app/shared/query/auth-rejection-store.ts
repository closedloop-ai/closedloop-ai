"use client";

import { AuthErrorCode, isAuthErrorCode } from "@repo/api/src/types/auth-error";
import { ApiError } from "../api/api-error";

/**
 * Cross-query auth-rejection signal (FEA-3940).
 *
 * The web shell's degraded/re-auth surface (`WorkspaceAuthGuard`) originally
 * watched only the `/me` query. But `/me` stays fresh for five minutes and the
 * shared client disables focus/reconnect refetches, so a session that breaks
 * after `/me` last succeeded would never re-run `/me`; a later session rejection
 * from some other query would leave the guard rendering the dead workspace.
 *
 * This module is the shared boundary that fixes that: the `QueryCache.onError`
 * hook wired in `makeQueryClient` publishes here whenever *any* query fails with
 * a Closedloop-session auth rejection, and the guard subscribes so it trips on
 * the first such failure regardless of which query produced it.
 *
 * Scope of "auth rejection" is deliberately narrow — an `ApiError` (thrown by
 * the shared `useApiClient`) that is a SESSION failure. Errors from other
 * transports that carry the same status but are NOT a first-party session
 * failure are excluded by keying on `ApiError` rather than a bare status check.
 *
 * WHICH STATUSES COUNT, AND WHY IT IS NOT SIMPLY "4xx AUTH" (ISS-5095).
 *
 * A bare 403 does NOT latch. 401 and 403 answer two different questions: 401 is
 * "we do not know who you are" — the session itself — while 403 is "we know
 * exactly who you are, and this particular thing is not yours". Latching on any
 * 403 meant one forbidden sub-resource replaced the entire workspace with "Your
 * session expired" — a claim that was false, whose **Sign in** button destroyed
 * a healthy session, and whose **Retry** could not clear it. That is what
 * `GET /teams/:id/repositories` did to every org member who opened the
 * create-document modal on a team they were not on.
 *
 * But status alone cannot carry the distinction, because `withAuth` also answers
 * 403 from `resolveOrgHeader` — the request named an organization this caller is
 * not a member of (org-switch race, or a membership revoked mid-session). Every
 * authenticated request carries the org header, so that condition fails every
 * query at once and re-authenticating is the only way out: a session failure
 * wearing a 403. That response is tagged
 * `AuthErrorCode.OrgForbidden`, and this boundary latches on it. So the rule is
 * "401, or a response the server explicitly tagged at the auth layer" — not a
 * status test, which is exactly the conflation that caused the bug.
 *
 * ISS-5118 is why that rule says "tagged", not "tagged 403". `withAuth` also
 * answers 503 `AuthErrorCode.OrgUnverifiable` when the Clerk lookup FAILED
 * rather than denying anyone. That is the same shape of condition — it rides the
 * same org header, so it fails every query on the page at once, and no
 * per-resource panel can explain it — so it belongs to the shell too. What it is
 * NOT is a dead session: the latched reason differs, and the recovery copy the
 * guard renders for it offers only Try again, never a sign-in that cannot fix a
 * provider outage. Latching on the code and choosing the copy from the REASON is
 * what lets one boundary serve both without either lying about the other.
 *
 * The `/me` query is deliberately NOT covered by the narrowing.
 * `WorkspaceAuthGuard` observes `/me` directly and still trips on either 401 or
 * 403 there, because `/me` is the identity probe: a 403 answering "who am I"
 * means the session cannot be established regardless of any code. The
 * distinction throughout is which question the failing request asked, not which
 * status code came back.
 *
 * A further exclusion is per-query opt-out: a query for a *specific resource*
 * whose 401 means "you can't see THIS thing" (not "your session is dead") owns
 * its own access-denied UI and must not blank the whole shell. Such a query sets
 * `meta: { [OWNS_AUTH_REJECTION_META_KEY]: true }` and the boundary skips it
 * (FEA-3940). The canonical case is `useBranchView`: a Branch View link the
 * viewer lacks access to returns 401 and the branch-view page renders its own
 * "Access required" panel — the shared re-auth surface must not hijack that
 * legitimate per-resource authorization state into a session-expired card.
 *
 * THE OPT-OUT DOES NOT OUTRANK AN EXPLICIT SESSION CODE. The opt-out is a claim
 * about a *resource* — "this query's authorization answers are mine to render".
 * A server-tagged {@link AuthErrorCode} is not a resource answer at all: it says
 * the session could not be established for the request, which no per-resource
 * panel can explain and no per-resource retry can clear. So
 * {@link publishAuthRejectionForQuery} tests the code FIRST and only then honors
 * the opt-out. Getting that order wrong is not theoretical: `useBranchView`,
 * `useBranchViewFileDiff`, and `use-trace-comments` all opt out and all run
 * through `withAuth`, so on a page whose only failing read is one of them, an
 * org-confirmation failure would render "Access required" — a per-resource claim
 * about a session-level failure, with a Retry that can never clear it — while
 * `/me` sat fresh for five minutes with focus and reconnect refetches off.
 */

type AuthRejectionListener = () => void;

/**
 * Query `meta` flag marking a query that owns its own access-denied UI, so the shared
 * auth-rejection boundary skips it (a per-resource authorization failure, not a
 * session-wide auth failure). See `queryOwnsAuthRejection`.
 */
export const OWNS_AUTH_REJECTION_META_KEY = "ownsAuthRejection" as const;

/**
 * Why the boundary latched. Each reason needs different recovery copy: a dead
 * session is fixed by signing in again; an organization that could not be
 * confirmed is usually an org-switch that raced or a membership changed
 * mid-session, where "Your session expired" is simply not what happened; and an
 * organization that could not be CHECKED at all is neither, so it must not offer
 * a re-auth that cannot fix a provider outage.
 */
export const AuthRejectionReason = {
  /** The session itself is not valid — a 401, or a 403 answering `/me`. */
  SessionExpired: "session-expired",
  /** The request's organization was checked and the answer was no. */
  OrgUnconfirmed: "org-unconfirmed",
  /**
   * The request's organization could not be CHECKED — the identity-provider
   * lookup failed (ISS-5118). Nothing about this user's access is known, so the
   * only honest affordance is to try again.
   */
  OrgUnverifiable: "org-unverifiable",
} as const;
export type AuthRejectionReason =
  (typeof AuthRejectionReason)[keyof typeof AuthRejectionReason];

let authRejection: AuthRejectionReason | null = null;
const listeners = new Set<AuthRejectionListener>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

/** True once any query has failed with a Closedloop-session auth rejection. */
export function getAuthRejected(): boolean {
  return authRejection !== null;
}

/**
 * Publish a session auth rejection when `error` is an `ApiError` that represents
 * a SESSION failure: a 401, or a 403 the server tagged with a session-level
 * {@link AuthErrorCode}. A no-op for any other error — including a bare 403,
 * which means "this resource is not yours" rather than "your session is dead"
 * (ISS-5095), and including gateway/runner errors that are not a first-party
 * session failure — so the global re-auth surface only trips on a real
 * Closedloop-session rejection.
 */
export function publishAuthRejectionIfAuthError(error: unknown): void {
  const reason = classifyAuthRejection(error);
  if (reason !== null && authRejection === null) {
    authRejection = reason;
    notify();
  }
}

/**
 * Clear the latched rejection — call after a successful re-auth or a recovered
 * `/me` so the guard stops showing the degraded surface.
 */
export function clearAuthRejection(): void {
  if (authRejection === null) {
    return;
  }
  authRejection = null;
  notify();
}

/** Subscribe to rejection/clear transitions; returns an unsubscribe fn. */
export function subscribeAuthRejection(
  listener: AuthRejectionListener
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True when a query's `meta` opts it out of the shared auth-rejection boundary
 * via `OWNS_AUTH_REJECTION_META_KEY`. Such a query owns its own access-denied UI
 * for a specific resource, so its 401 must NOT trip the global re-auth
 * surface. Accepts the query's `meta` (or `undefined`) so callers don't have to
 * reach through the React Query `Query` shape.
 */
export function queryOwnsAuthRejection(
  meta: Record<string, unknown> | undefined
): boolean {
  return meta?.[OWNS_AUTH_REJECTION_META_KEY] === true;
}

/**
 * True when `error` is a first-party session rejection rather than a
 * per-resource authorization answer (ISS-5095). See the module docstring for
 * why this is a code test and not a status test.
 *
 * Exported so a surface that needs the same distinction reads it from here
 * instead of re-deriving "401 or 403" and drifting back into the conflation.
 */
export function isSessionAuthRejection(error: unknown): boolean {
  return classifyAuthRejection(error) !== null;
}

/** The latched reason, or `null` when no rejection is outstanding. */
export function getAuthRejectionReason(): AuthRejectionReason | null {
  return authRejection;
}

/**
 * Classify `error` as a session rejection and say WHICH KIND, or `null` when it
 * is not one. The single place the "401, or a response the server explicitly
 * tagged at the auth layer" rule is expressed; every other predicate here defers
 * to it.
 */
export function classifyAuthRejection(
  error: unknown
): AuthRejectionReason | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const tagged = classifyServerTaggedRejection(error);
  if (tagged !== null) {
    return tagged;
  }
  if (error.isUnauthorized()) {
    return AuthRejectionReason.SessionExpired;
  }
  return null;
}

/**
 * True when the SERVER explicitly tagged this response at the auth layer with an
 * {@link AuthErrorCode}. Distinct from {@link isSessionAuthRejection}, which
 * also covers a plain 401 that carries no code: only an explicit tag outranks a
 * query's per-resource opt-out, because only the server can know that the
 * failure was not about the resource at all.
 */
export function isServerTaggedSessionRejection(error: unknown): boolean {
  return (
    error instanceof ApiError && classifyServerTaggedRejection(error) !== null
  );
}

/**
 * The reason behind a server-tagged auth response, or `null` when this response
 * carries no {@link AuthErrorCode}.
 *
 * Keyed on the CODE, not the status. Each code has its own transport (403 for
 * `org_forbidden`, 503 for `org_unverifiable`), so re-testing the status here
 * would just be the code's own contract restated in a second place — the exact
 * duplication ISS-5095 was caused by.
 */
function classifyServerTaggedRejection(
  error: ApiError
): AuthRejectionReason | null {
  if (!isAuthErrorCode(error.code)) {
    return null;
  }
  return SERVER_TAGGED_REJECTION_REASONS[error.code];
}

/**
 * Every {@link AuthErrorCode} the server can tag, and what the shell should say
 * about it. Exhaustive by construction, so a new code fails typecheck here
 * rather than falling into whichever branch happens to be last.
 */
const SERVER_TAGGED_REJECTION_REASONS: Record<
  AuthErrorCode,
  AuthRejectionReason
> = {
  [AuthErrorCode.OrgForbidden]: AuthRejectionReason.OrgUnconfirmed,
  // ISS-5118. Both belong to the shell — neither is an answer about a resource —
  // but they are not the same fact, and the recovery differs: the org was not
  // CHECKED here, so signing in again is not one of the things that can help.
  [AuthErrorCode.OrgUnverifiable]: AuthRejectionReason.OrgUnverifiable,
};

/**
 * The boundary decision for one failing query, precedence included, so
 * `QueryCache.onError` cannot re-derive it in a different order.
 *
 * A server-tagged session rejection publishes even from a query that opted out:
 * the opt-out claims the query owns its RESOURCE authorization answers, and this
 * is not one — no per-resource panel can explain it and no per-resource retry
 * can clear it. Everything else honors the opt-out, so a per-resource 401 still
 * renders that surface's own "Access required" state (FEA-3940).
 */
export function publishAuthRejectionForQuery(
  error: unknown,
  meta: Record<string, unknown> | undefined
): void {
  if (queryOwnsAuthRejection(meta) && !isServerTaggedSessionRejection(error)) {
    return;
  }
  publishAuthRejectionIfAuthError(error);
}

/**
 * The rule for the IDENTITY PROBE (`/me`) specifically: 401 or 403, coded or
 * not. `/me` asks "who am I", so a forbidden answer means the session cannot be
 * established regardless of any code — the one place status alone is the right
 * test. Exported so `WorkspaceAuthGuard` reads it here instead of re-deriving
 * "401 or 403" inline and drifting from the rule above.
 */
export function isIdentityProbeAuthRejection(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.isUnauthorized() || error.isForbidden())
  );
}
