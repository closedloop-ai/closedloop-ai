import { auth } from "@repo/auth/server";
import type { Organization } from "@repo/database";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { NextResponse } from "next/server";
import { getOAuthErrorRedirectUrl } from "./constants";

/**
 * Result type for authenticated organization lookup.
 * Either succeeds with organization data or returns an error redirect.
 */
export type OrgLookupResult =
  | { success: true; organization: Organization; clerkUserId: string }
  | { success: false; redirect: NextResponse };

/**
 * Authenticate the user and fetch their organization from the database.
 * Used by OAuth flow endpoints that need to verify the user's session and org.
 *
 * @param logPrefix - Prefix for log messages (e.g., "[linear/oauth]")
 * @returns Organization data if successful, or a redirect response for errors
 *
 * @example
 * ```typescript
 * const orgResult = await getAuthenticatedOrganization("[linear/oauth]");
 * if (!orgResult.success) {
 *   return orgResult.redirect; // User not authenticated or org not found
 * }
 * // Use orgResult.organization and orgResult.clerkUserId
 * ```
 */
export async function getAuthenticatedOrganization(
  logPrefix: string
): Promise<OrgLookupResult> {
  // Authenticate via Clerk session
  const { userId: clerkUserId, orgId: clerkOrgId } = await auth();

  if (!(clerkUserId && clerkOrgId)) {
    log.warn(`${logPrefix} Missing user or organization ID in session`);
    return {
      success: false,
      redirect: NextResponse.redirect(
        getOAuthErrorRedirectUrl("Not authenticated")
      ),
    };
  }

  // Find the organization in database
  const organization = await withDb((db) =>
    db.organization.findUnique({
      where: { clerkId: clerkOrgId },
    })
  );

  if (!organization) {
    log.warn(`${logPrefix} Organization not found`, { clerkOrgId });
    return {
      success: false,
      redirect: NextResponse.redirect(
        getOAuthErrorRedirectUrl("Organization not found")
      ),
    };
  }

  return { success: true, organization, clerkUserId };
}
