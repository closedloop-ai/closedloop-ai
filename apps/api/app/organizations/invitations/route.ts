import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { InviteMembersResponse } from "@repo/api/src/types/onboarding";
import type { PendingInvitationsPage } from "@repo/api/src/types/organization-members";
import { SettingsCommandCapability } from "@repo/api/src/types/settings-command";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import { requireSettingsCommand } from "@/lib/auth/settings-command";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { clerkFailureResponse } from "../clerk-error-mapping";
import { organizationsService } from "../service";
import {
  inviteMembersValidator,
  organizationListQueryValidator,
} from "../validators";
import { invitationAdminService } from "./invitation-admin-service";
import { recordInvitationReceipt } from "./invitation-receipt";
import { invitationsService } from "./service";

/**
 * GET /organizations/invitations
 *
 * The caller's organization's PENDING invitations, sourced from Clerk
 * (ISS-9083), for ISS-8368's Members panel.
 *
 * Open to any authenticated member of the organization, for the same reason the
 * sibling roster read is — see `../members/route.ts`. The POST below is the
 * gated half of this file, and the two authorization postures on one route file
 * are deliberate: reads follow `SETTINGS_DOMAIN_ACCESS_POLICY`'s
 * `read: EVERY_ROLE`, writes follow its `edit: ADMIN_AND_OWNER`.
 *
 * Org scoping is structural: the organization handed to Clerk is `clerkOrgId`
 * off the authenticated context, and this route accepts no organization
 * parameter.
 */
export const GET = withAnyAuth<
  PendingInvitationsPage,
  "/organizations/invitations"
>(async ({ clerkOrgId }, request) => {
  const { params, errorResponse: parseError } = parseQueryParams(
    request,
    organizationListQueryValidator
  );
  if (parseError) {
    return parseError;
  }

  const result = await invitationAdminService.listPendingInvitations({
    clerkOrgId,
    limit: params.limit,
    offset: params.offset,
  });

  if (!result.ok) {
    return clerkFailureResponse(result.error, {
      entity: "Organization",
      message: "Failed to list organization invitations",
    });
  }

  return successResponse(result.value);
});

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
>(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ clerkOrgId, user }, request, _params, receipts) => {
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

        // Only org admins/owners may invite. Both the authorization decision and
        // the org it authorizes read `clerkOrgId` off the authenticated context —
        // never the org row's own `clerkId`, which is caller-influenced input the
        // moment any future path resolves the row from a caller-supplied id.
        const denial = await requireSettingsCommand({
          clerkOrgId,
          clerkUserId: user.clerkId,
          domain: SettingsDomainId.Members,
          capability: SettingsCommandCapability.Admin,
        });
        if (denial) {
          return denial;
        }

        const response = await invitationsService.inviteMembers({
          organizationId: user.organizationId,
          clerkOrgId,
          inviterClerkUserId: user.clerkId,
          inviterUserId: user.id,
          emailAddresses: body.emailAddresses,
          role: body.role,
        });
        await recordInvitationReceipt(response, receipts);

        return successResponse(withOperationReceipt(response, receipts));
      } catch (error) {
        return errorResponse("Failed to send invitations", error);
      }
    }
  )
);
