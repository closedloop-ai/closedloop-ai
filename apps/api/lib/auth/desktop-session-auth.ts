import type { User } from "@repo/api/src/types/user";
import { verifyDesktopAccessToken } from "@repo/auth/desktop-session-jwt";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";

/**
 * Shared desktop-session resolution used by both the `withAnyAuth` wrapper and
 * the `resolveAnyAuthContext` SSE/streaming resolver (FEA-2217), so the two
 * surfaces verify desktop access tokens identically.
 *
 * Desktop access tokens carry the INTERNAL `userId`/`organizationId` (same shape
 * the API-key path resolves), so this re-reads the live user/org rows to build
 * the standard auth context — identical to `withApiKeyAuth`. The access token is
 * short-lived; loading the user here also means a deactivated user or a deleted
 * org takes effect immediately rather than only at token expiry.
 */
export type ResolvedDesktopSessionContext = {
  user: User;
  /** Internal organization id (matches the API-key/Clerk resolved shape). */
  organizationId: string;
  /** The organization's Clerk id, for `AuthContext.clerkOrgId`. */
  clerkOrgId: string;
};

/**
 * Verify a desktop access token and resolve the internal user/org it maps to.
 *
 * Returns `null` on an auth-level failure — an invalid/expired/forged token, or
 * an inactive/missing user, or a missing org. Callers MUST preclassify the token
 * as a desktop token (`isDesktopSessionToken`) first and treat `null` as 401 with
 * no fall-through to Clerk verification. Unexpected infrastructure errors (e.g.
 * the DB being unavailable) are NOT swallowed — they propagate so the request
 * fails closed (500) rather than masquerading as an auth rejection, matching the
 * API-key resolution path (`resolveApiKeyTokenContext`).
 *
 * Revocation is intentionally TTL-bounded: this does NOT read the `DesktopSession`
 * row, so a revoked session's already-minted access token stays valid until it
 * expires (`DEFAULT_ACCESS_TOKEN_TTL_SECONDS`, ~15 min). Per FEA-2217 (out of
 * scope: instant global revocation) and PLN-843 §Backend 4, baseline product
 * routes validate the signed token without a per-request session lookup; the
 * refresh path (`app/desktop/session/service.ts`) enforces `revokedAt`, so no NEW
 * tokens issue after revocation, and a sensitive route may opt into per-request
 * session validation separately if it needs a tighter window.
 */
export async function resolveDesktopSessionContext(
  token: string
): Promise<ResolvedDesktopSessionContext | null> {
  let claims: Awaited<ReturnType<typeof verifyDesktopAccessToken>>;
  try {
    claims = await verifyDesktopAccessToken(token);
  } catch {
    return null;
  }

  // Org-scoped lookup (same call the API-key path uses): a user that no longer
  // belongs to the token's org resolves to null.
  const user = await usersService.findById(
    claims.userId,
    claims.organizationId
  );
  if (!user?.active) {
    return null;
  }

  const organization = await organizationsService.findById(
    claims.organizationId
  );
  if (!organization) {
    return null;
  }

  return {
    user,
    organizationId: organization.id,
    clerkOrgId: organization.clerkId,
  };
}
