import { ApiKeySource } from "@repo/database";
import { waitUntil } from "@vercel/functions";
import { apiKeysService } from "@/app/api-keys/service";
import { usersService } from "@/app/users/service";
import {
  getDesktopManagedPopFailure,
  verifyDesktopManagedPop,
} from "@/lib/auth/desktop-managed-pop";

/**
 * Failure reasons returned by `authenticateDesktopManagedPopRequest`. Const
 * object per the project's "Define string enums as const objects" convention so
 * the values cross module boundaries as part of the helper's typed contract.
 */
export const DesktopManagedPopAuthFailure = {
  MissingBearer: "missing_bearer",
  InvalidKey: "invalid_key",
  InsufficientScope: "insufficient_scope",
  NotDesktopManaged: "not_desktop_managed",
  InactiveUser: "inactive_user",
  PopFailed: "pop_failed",
} as const;

export type DesktopManagedPopAuthFailure =
  (typeof DesktopManagedPopAuthFailure)[keyof typeof DesktopManagedPopAuthFailure];

export type DesktopManagedPopAuthResult =
  | {
      ok: true;
      organizationId: string;
      userId: string;
      gatewayId: string;
      apiKeyId: string;
    }
  | {
      ok: false;
      reason: DesktopManagedPopAuthFailure;
      status: number;
    };

/**
 * Authenticate a Desktop-managed PoP request: extract bearer token, verify key
 * metadata, assert DESKTOP_MANAGED source + bound public key + gateway + write
 * scope, verify the user is active, then verify the PoP signature. On success,
 * schedules `apiKeysService.touchLastUsedAt` via `waitUntil` so a transient DB
 * write failure does not affect the response path (matches the precedent at
 * `apps/api/app/internal/api-keys/verify/route.ts`, per the JSDoc on
 * `apiKeysService.touchLastUsedAt`).
 *
 * Returns a discriminated union. On failure, callers map `reason` → response
 * shape; the helper deliberately does not import response factories so it can
 * be consumed by routes with different external error contracts (e.g. the
 * heartbeat route always returns 410 Gone, while the execution-credentials
 * route preserves 401/403 by failure category).
 */
export async function authenticateDesktopManagedPopRequest(
  request: Request
): Promise<DesktopManagedPopAuthResult> {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token?.startsWith("sk_live_")) {
    return {
      ok: false,
      reason: DesktopManagedPopAuthFailure.MissingBearer,
      status: 401,
    };
  }

  const keyContext = await apiKeysService.verifyKeyWithMetadata(token, {
    updateLastUsedAt: false,
  });
  if (!keyContext) {
    return {
      ok: false,
      reason: DesktopManagedPopAuthFailure.InvalidKey,
      status: 401,
    };
  }
  if (!keyContext.scopes.includes("write")) {
    return {
      ok: false,
      reason: DesktopManagedPopAuthFailure.InsufficientScope,
      status: 403,
    };
  }
  if (
    keyContext.source !== ApiKeySource.DESKTOP_MANAGED ||
    !keyContext.boundPublicKey ||
    !keyContext.gatewayId
  ) {
    return {
      ok: false,
      reason: DesktopManagedPopAuthFailure.NotDesktopManaged,
      status: 403,
    };
  }

  const user = await usersService.findById(
    keyContext.userId,
    keyContext.organizationId
  );
  if (!user?.active) {
    return {
      ok: false,
      reason: DesktopManagedPopAuthFailure.InactiveUser,
      status: 401,
    };
  }

  const popFailure = getDesktopManagedPopFailure(
    verifyDesktopManagedPop({
      keyContext: { ...keyContext, clerkUserId: user.clerkId },
      request,
      mode: "enforce",
    })
  );
  if (popFailure) {
    return {
      ok: false,
      reason: DesktopManagedPopAuthFailure.PopFailed,
      status: popFailure.status,
    };
  }

  // Per the service JSDoc, serverless callers should not await this on the
  // response path. Centralising the `waitUntil` here means both consuming
  // routes get identical, SSOT-aligned behavior.
  waitUntil(apiKeysService.touchLastUsedAt(keyContext.apiKeyId));

  return {
    ok: true,
    organizationId: keyContext.organizationId,
    userId: keyContext.userId,
    gatewayId: keyContext.gatewayId,
    apiKeyId: keyContext.apiKeyId,
  };
}
