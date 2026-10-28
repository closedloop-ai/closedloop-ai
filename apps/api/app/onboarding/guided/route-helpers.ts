/**
 * @file route-helpers.ts
 * @description Response shaping for the guided onboarding routes (ISS-8375).
 */

import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import {
  GUIDED_ONBOARDING_STALE_REVISION_ERROR,
  type GuidedOnboardingTransitionResponse,
} from "@repo/api/src/types/onboarding-guided";
import { NextResponse } from "next/server";

/**
 * The 409 a stale transition receives, carrying the CURRENT snapshot so the
 * client reconciles from this response instead of retrying blind against a
 * revision the server has already moved past.
 *
 * `data` is `null` when the snapshot could not be composed — the conflict is
 * still the true outcome, and the client re-reads through GET rather than being
 * handed a 500 for a verdict the server reached.
 *
 * The outer response is cast to `ApiResult<never>` at the framework boundary
 * because `NextResponse` is invariant in its body type; producer and consumer
 * still agree on the exact shape through `conflictBody`.
 */
export function staleRevisionResponse(
  snapshot: GuidedOnboardingTransitionResponse
): NextResponse<ApiResult<never>> {
  return NextResponse.json(
    conflictBody(GUIDED_ONBOARDING_STALE_REVISION_ERROR, snapshot),
    { status: 409 }
  ) as NextResponse<ApiResult<never>>;
}
