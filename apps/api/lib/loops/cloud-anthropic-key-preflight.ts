import type { ApiResult } from "@repo/api/src/types/common";
import type { NextResponse } from "next/server";
import { apiKeyService } from "@/app/settings/api-key-service";
import { MISSING_ANTHROPIC_API_KEY_MESSAGE } from "@/lib/loops/loop-dispatch-utils";
import { badRequestResponse } from "@/lib/route-utils";

/**
 * Cloud pre-flight for the one precondition a Cloud loop cannot recover from:
 * an Anthropic API key must be resolvable for the loop owner (user key first,
 * then org key). Mirrors `resolveAnthropicApiKey` in `loop-orchestrator.ts`.
 *
 * This runs *before* the Loop row is created. Since ISS-5708 every launch route
 * awaits its dispatch, so `classifyLaunchFailure` would already turn a thrown
 * `MissingAnthropicApiKeyError` into the same 400 — surfacing the failure is no
 * longer this check's job, and it is not why the check is still here. Its
 * remaining, sole justification is the side effect: without it a keyless Cloud
 * run creates a Loop row purely to cancel it a moment later, and every retry
 * inserts another one. Do not read the surviving 400 as redundant and delete
 * the check.
 *
 * Local runs are skipped: they resolve the key on the desktop machine, so a
 * cloud-side key is not their precondition and blocking them would be wrong.
 * Returns `null` when the attempt may proceed.
 *
 * Shared by both doors onto a Cloud launch — `POST /documents/[id]/run-loop`
 * (via `run-loop-helpers`) and `POST /loops/[id]/resume` — because the
 * orphan-row side effect is a property of creating-then-cancelling, not of one
 * route. Resume reaches Cloud two ways: no target requested and the parent had
 * none, or the parent's target is no longer accessible and the route falls back
 * to Cloud. `loopsService.resume` writes `computeTargetId: computeTargetId ?? null`,
 * so an undefined resolved target genuinely means the child runs on ECS.
 */
export async function buildMissingAnthropicApiKeyResponse({
  resolvedComputeTargetId,
  userId,
  organizationId,
}: {
  resolvedComputeTargetId: string | undefined;
  userId: string;
  organizationId: string;
}): Promise<NextResponse<ApiResult<never>> | null> {
  // A resolved target means Local; only Cloud (`undefined`) needs the key here.
  if (resolvedComputeTargetId !== undefined) {
    return null;
  }
  const key = await apiKeyService.resolveApiKey(userId, organizationId);
  if (key) {
    return null;
  }
  return badRequestResponse(MISSING_ANTHROPIC_API_KEY_MESSAGE);
}
