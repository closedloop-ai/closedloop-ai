import type { ApiResult } from "@repo/api/src/types/common";
import {
  PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import type { NextResponse } from "next/server";
import {
  type FeatureFlagIdentity,
  isFeatureFlagEnabledForAnyIdentity,
} from "@/lib/feature-flag-identity";
import { forbiddenResponse } from "@/lib/route-utils";

export type PrdRequestChangesIdentity = FeatureFlagIdentity;

/**
 * Evaluates the `request_prd_changes` ("Amend PRD") rollout for server-side
 * admission at the run-loop endpoint. The PRD editor hides the menu item behind
 * the same flag, but a stale client or a direct API call can still POST the
 * dark-launched command, so the launch path must re-check the flag itself.
 *
 * Fail-closed: unavailable, false, null, or a thrown evaluation all resolve to
 * false so the command can never be dispatched outside the flag.
 */
export function isPrdRequestChangesEnabled(
  identity: PrdRequestChangesIdentity
): Promise<boolean> {
  return isFeatureFlagEnabledForAnyIdentity(
    PRD_REQUEST_CHANGES_FEATURE_FLAG_KEY,
    identity,
    "prd_request_changes_feature_flag_unavailable"
  );
}

/**
 * Server-side admission gate for the dark-launched `request_prd_changes`
 * command. Returns a 403 response to block the launch when the flag is not
 * explicitly enabled for the requester, or null when the request may proceed.
 * Every other command passes through untouched.
 */
export async function enforcePrdRequestChangesGate(
  command: RunLoopCommand,
  identity: PrdRequestChangesIdentity
): Promise<NextResponse<ApiResult<never>> | null> {
  if (command !== RunLoopCommand.RequestPrdChanges) {
    return null;
  }
  if (await isPrdRequestChangesEnabled(identity)) {
    return null;
  }
  return forbiddenResponse({ code: "feature_disabled" });
}
