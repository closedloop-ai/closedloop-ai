import type { InviteMembersResponse } from "@repo/api/src/types/onboarding";
import { isOrgAdmin } from "@/lib/auth/org-admin";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { organizationsService } from "../service";
import { inviteMembersValidator } from "../validators";
import { invitationsService } from "./service";

/**
 * POST /organizations/invitations
 *
 * "Invite your team" (PRD-532 §5.4). Mints real Clerk organization invitations
 * for the caller's own organization. On accept, Clerk's
 * `organizationMembership.created` webhook syncs a durable MEMBER into the
 * existing org (`handleOrganizationMembershipCreated`) — the invitee joins the
 * caller's org, not a new org-of-one.
 *
 * Org-scoping: the target org is derived from the authenticated caller's
 * session (`user.organizationId`), never from the request body, and the caller
 * must be an org admin/owner. This forecloses inviting into an org the caller
 * does not administer.
 */
export const POST = withAnyAuth<
  InviteMembersResponse,
  "/organizations/invitations"
>(async ({ user }, request) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      inviteMembersValidator
    );
    if (parseError || !body) {
      return parseError;
    }

    // Resolve the caller's org to its Clerk id — the invitation is always
    // scoped to the caller's own organization.
    const organization = await organizationsService.findById(
      user.organizationId
    );
    if (!organization) {
      return notFoundResponse("Organization");
    }

    // Only org admins/owners may invite. Authorization is checked against
    // Clerk's membership role for the caller in this specific org.
    const callerIsAdmin = await isOrgAdmin(organization.clerkId, user.clerkId);
    if (!callerIsAdmin) {
      return forbiddenResponse();
    }

    const response = await invitationsService.inviteMembers({
      clerkOrgId: organization.clerkId,
      inviterClerkUserId: user.clerkId,
      emailAddresses: body.emailAddresses,
      role: body.role,
    });

    return successResponse(response);
  } catch (error) {
    return errorResponse("Failed to send invitations", error);
  }
});
