import {
  AuthErrorCode,
  ORG_UNVERIFIABLE_MESSAGE,
} from "@repo/api/src/types/auth-error";
import { serviceUnavailableResponse } from "../route-utils";

/**
 * The failure contract for `resolveAnyAuthContext`, and the boundary response
 * that answers it.
 *
 * Its own module, separate from the resolver, for two reasons: the routes that
 * consume it mock the resolver wholesale in their tests, and `route-utils`
 * would be a circular import from the resolver's side. Keeping the contract
 * here means the mapping below is the single place a failure becomes a status
 * code, rather than five routes each spelling one out.
 */

export type ResolvedAuthContext = {
  organizationId: string;
  userId: string;
};

/**
 * Why identity could not be resolved.
 *
 * The split exists for the same reason as the one in {@link AuthErrorCode}
 * (ISS-5118): "we decided you may not" and "we could not decide" are different
 * facts, and a single `null` said only the first. `withAuth` already separates
 * them; this is the same separation for the boundaries that cannot use it.
 */
export const AuthContextFailure = {
  /**
   * No valid identity: no credential, an invalid one, or one that resolves to
   * no active user. The caller's own answer is a 401.
   */
  Unauthenticated: "unauthenticated",
  /**
   * The request's organization could not be VERIFIED — the identity-provider
   * lookup failed, so nothing about this caller's access is known. An
   * availability failure, answered with a retryable 503, never a 401.
   */
  OrgUnverifiable: "org-unverifiable",
} as const;
export type AuthContextFailure =
  (typeof AuthContextFailure)[keyof typeof AuthContextFailure];

export type AnyAuthContextResult =
  | { ok: true; context: ResolvedAuthContext }
  | { ok: false; failure: AuthContextFailure };

export const UNAUTHENTICATED: AnyAuthContextResult = {
  ok: false,
  failure: AuthContextFailure.Unauthenticated,
};

export const ORG_UNVERIFIABLE: AnyAuthContextResult = {
  ok: false,
  failure: AuthContextFailure.OrgUnverifiable,
};

/**
 * The boundary response for a failed `resolveAnyAuthContext`, shared by the
 * streaming and collaboration routes that return a raw `Response` instead of
 * going through `withAuth`. This is what makes those routes answer the same
 * 503 / `org_unverifiable` contract `withAuth` does, instead of reporting an
 * identity-provider outage as bad credentials.
 *
 * Exhaustive by construction: the `Record` means a new
 * {@link AuthContextFailure} fails typecheck until it is deliberately answered,
 * rather than defaulting into the 401 this function exists to stop
 * over-reporting.
 */
export function authContextFailureResponse(
  failure: AuthContextFailure
): Response {
  return AUTH_CONTEXT_FAILURE_RESPONSES[failure]();
}

const AUTH_CONTEXT_FAILURE_RESPONSES: Record<
  AuthContextFailure,
  () => Response
> = {
  // Unchanged from before the split, deliberately: this is the existing wire
  // contract for these routes and nothing about a bad credential changed.
  [AuthContextFailure.Unauthenticated]: () =>
    new Response("Unauthorized", { status: 401 }),
  [AuthContextFailure.OrgUnverifiable]: () =>
    serviceUnavailableResponse(ORG_UNVERIFIABLE_MESSAGE, {
      code: AuthErrorCode.OrgUnverifiable,
    }),
};
