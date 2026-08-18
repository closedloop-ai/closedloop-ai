import {
  type InviteMemberResult,
  type InviteMembersResponse,
  OrgInviteRole,
} from "@repo/api/src/types/onboarding";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

/**
 * Clerk returns HTTP 400 with this error code when the email already belongs to
 * the organization (member or pending invite). Treated as a non-fatal, per-email
 * "already_member" outcome rather than failing the whole batch.
 */
const CLERK_DUPLICATE_INVITE_CODES = new Set([
  "duplicate_record",
  "organization_membership_exists",
  "already_a_member_in_organization",
]);

type ClerkErrorLike = {
  errors?: Array<{ code?: string; message?: string; longMessage?: string }>;
};

function extractClerkErrorCode(error: unknown): string | undefined {
  const clerkError = error as ClerkErrorLike;
  return clerkError?.errors?.[0]?.code;
}

function extractClerkErrorMessage(error: unknown): string | undefined {
  const clerkError = error as ClerkErrorLike;
  const first = clerkError?.errors?.[0];
  return first?.longMessage ?? first?.message;
}

export const invitationsService = {
  /**
   * Mint real Clerk org invitations for each email into the given Clerk org.
   * Clerk's `createOrganizationInvitation` is singular, so we invite per-email
   * and aggregate per-email outcomes — one bad address does not abort the rest.
   * De-duplication is handled upstream by the Zod validator.
   */
  async inviteMembers(params: {
    clerkOrgId: string;
    inviterClerkUserId: string;
    emailAddresses: string[];
    role?: OrgInviteRole;
  }): Promise<InviteMembersResponse> {
    const role = params.role ?? OrgInviteRole.Member;
    const results: InviteMemberResult[] = [];

    for (const email of params.emailAddresses) {
      try {
        const invitation = await clerkService.createOrganizationInvitation({
          organizationId: params.clerkOrgId,
          emailAddress: email,
          role,
          inviterUserId: params.inviterClerkUserId,
        });
        results.push({
          email,
          invitationId: invitation.id,
          status: "invited",
        });
      } catch (error) {
        const code = extractClerkErrorCode(error);
        if (code && CLERK_DUPLICATE_INVITE_CODES.has(code)) {
          results.push({
            email,
            status: "already_member",
            reason: "Email is already a member or has a pending invitation",
          });
          continue;
        }
        log.error("Failed to create Clerk organization invitation", {
          clerkOrgId: params.clerkOrgId,
          email,
          code,
          error,
        });
        results.push({
          email,
          status: "failed",
          reason:
            extractClerkErrorMessage(error) ?? "Failed to send invitation",
        });
      }
    }

    const invited = results.filter((r) => r.status === "invited").length;
    return { invited, results };
  },
};
