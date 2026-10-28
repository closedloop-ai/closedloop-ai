import "server-only";

import type { PendingInvitationsPage } from "@repo/api/src/types/organization-members";
import { Result } from "@repo/api/src/types/result";
import { ClerkInvitationStatus, clerkService } from "@/lib/auth/clerk-service";
import {
  type ClerkOperationFailure,
  toClerkOperationFailure,
} from "../clerk-error-mapping";
import { toPendingInvitationSummary } from "../clerk-organization-mappers";
import {
  ClerkTimestampResource,
  logClerkTimestampGaps,
} from "../clerk-timestamp-gap-log";

/**
 * @file invitation-admin-service.ts
 * @description Administration of an organization's existing invitations
 * (ISS-9083) — listing them now, revoking and resending them in M4.
 *
 * A SEPARATE RESPONSIBILITY from the sibling `service.ts`, which owns the
 * onboarding invite batch and writes the onboarding invites-sent marker. That
 * is why the resend in M4 must call the Clerk boundary directly rather than go
 * through `inviteMembers`: routing an administrative resend through the
 * onboarding path would re-stamp a marker that says the org just finished
 * inviting its team.
 */
export const invitationAdminService = {
  /**
   * One bounded page of the organization's PENDING invitations.
   *
   * Filtered at the provider, so an accepted or revoked invitation never
   * reaches the page. The filter is not licence to stamp `status` on a row that
   * arrived without one — see `toPendingInvitationSummary`.
   *
   * Same org-scoping and same failure contract as the roster read: the org is
   * the authenticated caller's own, and a provider failure is a `Result.err`
   * rather than an empty list.
   */
  async listPendingInvitations(params: {
    clerkOrgId: string;
    limit: number;
    offset: number;
  }): Promise<Result<PendingInvitationsPage, ClerkOperationFailure>> {
    try {
      const page = await clerkService.listOrganizationInvitations({
        organizationId: params.clerkOrgId,
        limit: params.limit,
        offset: params.offset,
        status: [ClerkInvitationStatus.Pending],
      });

      const invitations = page.data.map(toPendingInvitationSummary);

      logClerkTimestampGaps({
        clerkOrgId: params.clerkOrgId,
        resource: ClerkTimestampResource.Invitations,
        affectedRowIds: invitations
          .filter(
            (invitation) =>
              invitation.createdAt === null ||
              invitation.updatedAt === null ||
              invitation.expiresAt === null
          )
          .map((invitation) => invitation.invitationId),
      });

      return Result.ok({
        invitations,
        total: page.totalCount,
        hasMore: params.offset + invitations.length < page.totalCount,
      });
    } catch (error) {
      return Result.err(toClerkOperationFailure(error));
    }
  },
};
