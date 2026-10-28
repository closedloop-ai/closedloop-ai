import "server-only";

import {
  type OrganizationMembersPage,
  OrganizationMembersSource,
} from "@repo/api/src/types/organization-members";
import { Result } from "@repo/api/src/types/result";
import {
  type ClerkOrganizationMembership,
  type ClerkPage,
  clerkService,
} from "@/lib/auth/clerk-service";
import { listSeededRoster } from "@/lib/auth/seeded-roster";
import { isSeededVibeEnvironmentRuntime } from "@/lib/seeded-vibe-environment";
import {
  type ClerkOperationFailure,
  toClerkOperationFailure,
} from "../clerk-error-mapping";
import { toOrganizationMemberSummary } from "../clerk-organization-mappers";
import {
  ClerkTimestampResource,
  logClerkTimestampGaps,
} from "../clerk-timestamp-gap-log";

/**
 * @file service.ts
 * @description Organization membership administration, sourced from Clerk
 * (ISS-9083). Clerk is the source of truth for who belongs to an organization;
 * the local `User` mirror carries a different role axis entirely and is not a
 * substitute.
 *
 * `changeRole` and `removeMember` land with the mutations (M4). This module
 * currently owns the roster read.
 *
 * ISS-12135: a seeded vibe preview is the one exception. Its Clerk
 * organization is a real one bound to the seeded rows, so its roster is read
 * from those rows instead ({@link listSeededRoster}), and every page says
 * which source it came from so the Members panel never has to guess.
 */
export const organizationMembersService = {
  /**
   * One bounded page of the organization's roster.
   *
   * `clerkOrgId` is the authenticated caller's own organization and never a
   * request value — that is what forecloses reading another organization's
   * roster, and it is what the route tests assert.
   *
   * `limit` and `offset` arrive already clamped by the query validator.
   *
   * Every provider failure becomes a `Result.err`, never an empty page: "this
   * organization has one member" and "Clerk did not answer" must stay
   * distinguishable, which is the criterion ISS-9083 names.
   *
   * And nothing inside the `try` but the Clerk call can throw — the mapper
   * answers an unreadable timestamp with `null` rather than a `RangeError`, and
   * the gap log cannot fail — so classifying everything caught as a provider
   * failure blames the provider for a failure the provider actually had.
   */
  async listMembers(params: {
    clerkOrgId: string;
    limit: number;
    offset: number;
  }): Promise<Result<OrganizationMembersPage, ClerkOperationFailure>> {
    // Outside the `try`: a failed database read is not a provider failure.
    if (await isSeededVibeEnvironmentRuntime()) {
      return Result.ok(
        toMembersPage(
          await seededRosterPage(params),
          params.offset,
          OrganizationMembersSource.Seeded
        )
      );
    }
    try {
      const page = await clerkService.listOrganizationMemberships({
        organizationId: params.clerkOrgId,
        limit: params.limit,
        offset: params.offset,
      });

      const result = toMembersPage(
        page,
        params.offset,
        OrganizationMembersSource.Clerk
      );

      logClerkTimestampGaps({
        clerkOrgId: params.clerkOrgId,
        resource: ClerkTimestampResource.Memberships,
        // The provider row's own id, not the summary's `userId`, which is
        // itself nullable and so cannot name the row it went missing on.
        affectedRowIds: page.data
          .filter((_, index) => result.members[index].createdAt === null)
          .map((membership) => membership.id),
      });

      return Result.ok(result);
    } catch (error) {
      return Result.err(toClerkOperationFailure(error));
    }
  },
};

async function seededRosterPage(params: {
  clerkOrgId: string;
  limit: number;
  offset: number;
}): Promise<ClerkPage<ClerkOrganizationMembership>> {
  const all = await listSeededRoster({ clerkOrgId: params.clerkOrgId });
  return {
    data: all.slice(params.offset, params.offset + params.limit),
    totalCount: all.length,
  };
}

function toMembersPage(
  page: ClerkPage<ClerkOrganizationMembership>,
  offset: number,
  source: OrganizationMembersSource
): OrganizationMembersPage {
  const members = page.data.map(toOrganizationMemberSummary);
  return {
    members,
    total: page.totalCount,
    // Against the population reported, not against the page size: a full page
    // is not evidence of a next one, and a short page is not evidence there is
    // no next one when the offset is past the end.
    hasMore: offset + members.length < page.totalCount,
    source,
  };
}
