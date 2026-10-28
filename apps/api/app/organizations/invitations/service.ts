import {
  type InviteMemberResult,
  InviteMemberStatus,
  type InviteMembersResponse,
  OrgInviteRole,
} from "@repo/api/src/types/onboarding";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";
import { onboardingService } from "../../onboarding/service";

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
    organizationId: string;
    clerkOrgId: string;
    inviterClerkUserId: string;
    /**
     * The APP user doing the inviting (ISS-11670), for the per-user
     * invites-sent marker. Distinct from `inviterClerkUserId`, which is the
     * Clerk principal Clerk's own invitation is attributed to.
     */
    inviterUserId: string;
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
          status: InviteMemberStatus.Invited,
        });
      } catch (error) {
        const code = extractClerkErrorCode(error);
        if (code && CLERK_DUPLICATE_INVITE_CODES.has(code)) {
          results.push({
            email,
            status: InviteMemberStatus.AlreadyMember,
            reason: "Email is already a member or has a pending invitation",
          });
          continue;
        }
        log.error("Failed to create Clerk organization invitation", {
          // ISS-8866: the APP org, not the Clerk one. `clerkOrgId` stays
          // because it is what the failing Clerk call was scoped to, but it is
          // the id an operator cannot pivot a tenant on without a join.
          organizationId: params.organizationId,
          clerkOrgId: params.clerkOrgId,
          email,
          code,
          error,
        });
        results.push({
          email,
          status: InviteMemberStatus.Failed,
          reason:
            extractClerkErrorMessage(error) ?? "Failed to send invitation",
        });
      }
    }

    const invited = results.filter(
      (r) => r.status === InviteMemberStatus.Invited
    ).length;
    if (invited > 0) {
      await recordInvitesSent(params.organizationId);
      await recordUserInvitesSent(params.organizationId, params.inviterUserId);
    }
    return { invited, results };
  },
};

/**
 * Mark the org as having invited someone, which is what completes the
 * onboarding checklist's invite row.
 *
 * Best-effort by design: the invitations are already minted by the time this
 * runs, so a failed marker write must not fail the caller's request. The cost
 * is an unticked checklist row until the next invite lands.
 */
async function recordInvitesSent(organizationId: string): Promise<void> {
  try {
    await onboardingService.recordInvitesSent(organizationId);
  } catch (error) {
    log.error("Failed to record onboarding invites-sent marker", {
      organizationId,
      error,
    });
  }
}

/**
 * Mark this USER as having invited someone, which is what completes the guided
 * run's invite step (ISS-11670).
 *
 * Gated on `invited > 0` by its caller, the same as the org marker above, so
 * `already_member` — a 200 that invites nobody — stamps nothing and leaves the
 * step outstanding for a reader who sent no invitation.
 *
 * Best-effort for the same reason the org marker is: the invitations are
 * already minted by the time this runs, so a failed marker write must not fail
 * the caller's request. The cost is an invite step that asks again.
 */
async function recordUserInvitesSent(
  organizationId: string,
  userId: string
): Promise<void> {
  try {
    await onboardingService.recordUserInvitesSent(organizationId, userId);
  } catch (error) {
    log.error("Failed to record per-user onboarding invites-sent marker", {
      organizationId,
      userId,
      error,
    });
  }
}
