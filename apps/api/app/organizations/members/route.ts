import type { OrganizationMembersPage } from "@repo/api/src/types/organization-members";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseQueryParams, successResponse } from "@/lib/route-utils";
import { clerkFailureResponse } from "../clerk-error-mapping";
import { organizationListQueryValidator } from "../validators";
import { organizationMembersService } from "./service";

/**
 * GET /organizations/members
 *
 * The caller's organization roster, sourced from Clerk with Clerk organization
 * roles (ISS-9083), for ISS-8368's Members panel. On a seeded vibe preview it
 * is the seeded rows instead, and every page's `source` says which (ISS-12135).
 *
 * NO ADMIN GATE, and that is the decision rather than an omission.
 * `SETTINGS_DOMAIN_ACCESS_POLICY` puts Members at `read: EVERY_ROLE`, so
 * admin-gating this read would contradict the same table the Settings view
 * model is projected from: a plain member would be told the panel is readable
 * and then refused here. `requireSettingsCommand` could not express it in any
 * case — `SettingsCommandCapability` has no `read` member by construction. The
 * four mutations DO gate, through that helper. Confirmed with Kerensa, 2026-09-04;
 * ISS-9083 v3 carries the correction.
 *
 * ORG SCOPING is structural, not a check: the organization handed to Clerk is
 * `clerkOrgId` off the authenticated context, and this route accepts no
 * organization parameter at all, so there is no request value that could name
 * another org.
 */
export const GET = withAnyAuth<
  OrganizationMembersPage,
  "/organizations/members"
>(async ({ clerkOrgId }, request) => {
  const { params, errorResponse: parseError } = parseQueryParams(
    request,
    organizationListQueryValidator
  );
  if (parseError) {
    return parseError;
  }

  const result = await organizationMembersService.listMembers({
    clerkOrgId,
    limit: params.limit,
    offset: params.offset,
  });

  if (!result.ok) {
    return clerkFailureResponse(result.error, {
      entity: "Organization",
      message: "Failed to list organization members",
    });
  }

  return successResponse(result.value);
});
