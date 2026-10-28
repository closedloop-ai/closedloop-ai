import { SessionMeshForbiddenCode } from "@repo/api/src/types/session-mesh";
import type { RequiredApiKeyScopes } from "@/lib/auth/api-key-scopes";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type { AuthenticatedHandler } from "@/lib/auth/with-auth";
import { isFeatureFlagEnabledForAnyIdentity } from "@/lib/feature-flag-identity";
import { SESSION_MESH_V1_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { forbiddenResponse } from "@/lib/route-utils";
import { meshRequestBudget } from "./request-budget";

/** Gate cloud activity as well as UI. A disabled Mesh never affects the harness. */
export function withSessionMeshAuth<T>(
  handler: AuthenticatedHandler<T>,
  options?: { requiredScopes?: RequiredApiKeyScopes }
) {
  return withAnyAuth<T>(async (context, request, params) => {
    const throttled = meshRequestBudget.check(
      request,
      context.user.organizationId,
      context.user.id
    );
    if (throttled) {
      return throttled;
    }
    const enabled = await isFeatureFlagEnabledForAnyIdentity(
      SESSION_MESH_V1_SERVER_FLAG,
      { userId: context.user.id, clerkUserId: context.clerkUserId },
      "session_mesh_feature_flag_unavailable"
    );
    if (!enabled) {
      // ISS-11425 — this STAYS 403 with this code, deliberately. "Not in the
      // rollout" is a poor fit for an authorization status, but already-shipped
      // Desktop builds latch their denial on exactly this status-and-code pair
      // (`inspectServerDenial`), so any other status makes a skewed client stop
      // latching and re-probe on its 5s timer instead of its backoff — the storm
      // this ticket closes, made worse. A client learns "off" from its own
      // PostHog assignment now (`session-mesh-denial-policy.ts`), which is the
      // fix for discovering a rollout state through an error at all.
      return forbiddenResponse({ code: SessionMeshForbiddenCode.Disabled });
    }
    return handler(context, request, params);
  }, options);
}
