import "server-only";

import type { ApiResult } from "@repo/api/src/types/common";
import { OrganizationMembersErrorCode } from "@repo/api/src/types/organization-members";
import type { NextResponse } from "next/server";
import { isClerkNotFound } from "@/lib/auth/clerk-service";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";

/**
 * @file clerk-error-mapping.ts
 * @description One mapping from a thrown Clerk failure to the answer the
 * Members surface gives for it, shared by every service under
 * `/organizations` so the roster read and the invitation read cannot drift into
 * reporting the same provider condition two different ways (ISS-9083).
 *
 * WHY THE CAUSE TRAVELS WITH THE CODE. The service classifies but does not log:
 * the route is where `errorResponse` records the failure AND attributes it to
 * the request span, so a service that logged and discarded the cause would
 * produce a 503 with no span attribution and a duplicate log line.
 *
 * The mapping is deliberately narrow. It covers the two outcomes a READ can
 * produce; the mutation-specific conditions (an already-settled invitation, the
 * last-owner rule, a role the instance has not configured) arrive with the
 * mutations that can hit them.
 */

/**
 * How a failed Clerk call is classified INSIDE this API.
 *
 * Backend-only, and deliberately not in `packages/api/src/types/`: that module
 * is the transport contract, and `NotFound` never reaches the wire — the shared
 * 404 helper answers it with no `code` at all. A discriminant a client can never
 * observe does not belong in the shape that describes what a client receives.
 *
 * `ProviderUnavailable` is spelled by reference rather than repeated, because
 * that one IS serialized: the two must stay the same string.
 */
export const ClerkFailureKind = {
  /** The organization, membership, or invitation Clerk was asked for is absent. */
  NotFound: "not_found",
  /** Clerk was unreachable, or failed for a reason this contract cannot name. */
  ProviderUnavailable: OrganizationMembersErrorCode.ProviderUnavailable,
} as const;

export type ClerkFailureKind =
  (typeof ClerkFailureKind)[keyof typeof ClerkFailureKind];

/** A Clerk call that failed, classified, with the original error kept. */
export type ClerkOperationFailure = {
  code: ClerkFailureKind;
  /** The thrown value, for the route to log and attribute. */
  cause: unknown;
};

export type FailureContext = {
  /** Subject of the 404, e.g. `"Organization"`. */
  entity: string;
  /** Operator-facing message logged with the 503. */
  message: string;
};

type ClerkFailureResponse = NextResponse<ApiResult<never>>;

/**
 * The provider spoke and we could not read it, or it did not speak at all.
 *
 * 503, matching every other read on this API that could not ask the identity
 * provider: `GET /settings/browser-sessions` answers its Clerk failure 503
 * `provider_unavailable`, and the org-admin gate answers an unresolved role 503
 * `role_unresolved` (`lib/auth/org-admin-denial.ts`). All three are the same
 * fact — nobody established anything, and the request is safe to repeat — so a
 * client keyed on status must not read one Settings panel's Clerk outage as a
 * gateway failure and its neighbour's as a service outage.
 */
const PROVIDER_UNAVAILABLE_STATUS = 503;

/**
 * How the Members surface answers a classified Clerk failure.
 *
 * An exhaustive `Record`, so a new {@link ClerkFailureKind} fails typecheck here
 * until it is deliberately answered — rather than falling into whichever branch
 * happens to be last.
 */
const FAILURE_RESPONSES: Record<
  ClerkFailureKind,
  (
    failure: ClerkOperationFailure,
    context: FailureContext
  ) => ClerkFailureResponse
> = {
  [ClerkFailureKind.NotFound]: (_failure, context) =>
    notFoundResponse(context.entity),
  [ClerkFailureKind.ProviderUnavailable]: (failure, context) =>
    errorResponse(context.message, failure.cause, PROVIDER_UNAVAILABLE_STATUS, {
      code: OrganizationMembersErrorCode.ProviderUnavailable,
    }),
};

/**
 * Classify a thrown Clerk failure.
 *
 * Only a provider-reported 404 is not-found. A transport failure, a timeout, or
 * a thrown non-error is deliberately NOT one: reporting an outage as "this
 * organization has no such member" would tell the caller a fact nobody
 * established.
 */
export function toClerkOperationFailure(error: unknown): ClerkOperationFailure {
  return {
    code: isClerkNotFound(error)
      ? ClerkFailureKind.NotFound
      : ClerkFailureKind.ProviderUnavailable,
    cause: error,
  };
}

/** The HTTP answer for a classified Clerk failure. */
export function clerkFailureResponse(
  failure: ClerkOperationFailure,
  context: FailureContext
): ClerkFailureResponse {
  return FAILURE_RESPONSES[failure.code](failure, context);
}
