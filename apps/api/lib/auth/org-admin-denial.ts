import type { ApiResult } from "@repo/api/src/types/common";
import { Status, type StatusCode } from "@repo/api/src/types/result";
import type { NextResponse } from "next/server";
import {
  forbiddenResponse,
  serviceUnavailableResponse,
} from "@/lib/route-utils";

/**
 * The refusal half of the org-admin gate: why it refused, and what that refusal
 * looks like on the wire.
 *
 * Its own leaf module, apart from `org-admin.ts`, because it is a pure mapping
 * with no identity-provider dependency — so a route can import it while its
 * suite stubs the Clerk-backed decision next door.
 */

/**
 * Why an admin gate refused.
 *
 * The two are different facts, not two spellings of one. `NotAdmin` means Clerk
 * answered and the caller does not hold a privileged role — an authorization
 * DECISION. `ProviderError` means the role was never resolved at all, so
 * nothing about this caller's access is known.
 */
export const OrgAdminDenialReason = {
  NotAdmin: "not_admin",
  ProviderError: "provider_error",
} as const;
export type OrgAdminDenialReason =
  (typeof OrgAdminDenialReason)[keyof typeof OrgAdminDenialReason];

/**
 * Codes an admin gate tags its refusal with.
 *
 * Deliberately NOT a member of {@link AuthErrorCode}: every code in that
 * vocabulary is a statement about the SESSION, and the web shell latches the
 * whole workspace on one (`auth-rejection-store.ts`). A per-route admin gate
 * that could not read a role has not said anything about the session, so it
 * must not blank the workspace.
 */
export const OrgAdminGateErrorCode = {
  /**
   * The caller's org role could not be resolved because the identity-provider
   * lookup failed (ISS-8661). An AVAILABILITY failure, not an authorization
   * decision — carried on a 503 because the condition is transient and the
   * request is safe to repeat.
   */
  RoleUnresolved: "role_unresolved",
} as const;
export type OrgAdminGateErrorCode =
  (typeof OrgAdminGateErrorCode)[keyof typeof OrgAdminGateErrorCode];

/**
 * Wire copy for {@link OrgAdminGateErrorCode.RoleUnresolved}, canonical here so
 * a gate cannot drift into telling the user they lack permission for an outage.
 */
export const ROLE_UNRESOLVED_MESSAGE =
  "Couldn't check your organization role. Try again.";

/**
 * The response an admin gate answers a refusal with, split by WHY it refused.
 *
 * Before ISS-8661 every gate answered 403 for both reasons, so a Clerk outage
 * was indistinguishable on the wire from a genuine denial: the caller was told
 * they lack permission when the truth was that nobody could check. Still fails
 * CLOSED — the gated work does not run either way — but a 503 says "we could
 * not decide" rather than "we decided no".
 *
 * Exhaustive by construction: a new {@link OrgAdminDenialReason} fails
 * typecheck here until it is deliberately answered, rather than defaulting into
 * the 403 this mapping exists to stop over-reporting.
 *
 * The 503 is deliberately ABOVE `route-utils`' server-error threshold, so
 * `logRequestCompleted` records it at `error` level and it joins the generic
 * error-rate population. That is intended: a role we could not read IS a
 * server-side failure, and it is the same classification `with-auth` already
 * gives the identical Clerk-lookup failure via `AuthErrorCode.OrgUnverifiable`.
 * The narrow `org_admin_gate_denied` monitor stays separate and unchanged.
 */
export function orgAdminDenialResponse(
  reason: OrgAdminDenialReason
): NextResponse<ApiResult<never>> {
  return ORG_ADMIN_DENIAL_RESPONSES[reason]();
}

const ORG_ADMIN_DENIAL_RESPONSES: Record<
  OrgAdminDenialReason,
  () => NextResponse<ApiResult<never>>
> = {
  [OrgAdminDenialReason.NotAdmin]: () => forbiddenResponse(),
  [OrgAdminDenialReason.ProviderError]: () =>
    serviceUnavailableResponse(ROLE_UNRESOLVED_MESSAGE, {
      code: OrgAdminGateErrorCode.RoleUnresolved,
    }),
};

/**
 * The unresolved-role 503 on its own, for a caller that holds a status code or a
 * verdict of its own rather than an {@link OrgAdminDenialReason}. Reads from the
 * same mapping, so the message and code cannot drift between call sites.
 */
export function roleUnresolvedResponse(): NextResponse<ApiResult<never>> {
  return ORG_ADMIN_DENIAL_RESPONSES[OrgAdminDenialReason.ProviderError]();
}

/**
 * The same split as {@link orgAdminDenialResponse}, for a service that answers
 * with a `Result<_, StatusCode>` instead of building the response itself.
 * Exhaustive for the same reason.
 */
export function orgAdminDenialStatus(reason: OrgAdminDenialReason): StatusCode {
  return ORG_ADMIN_DENIAL_STATUSES[reason];
}

const ORG_ADMIN_DENIAL_STATUSES: Record<OrgAdminDenialReason, StatusCode> = {
  [OrgAdminDenialReason.NotAdmin]: Status.Forbidden,
  [OrgAdminDenialReason.ProviderError]: Status.ServiceUnavailable,
};
