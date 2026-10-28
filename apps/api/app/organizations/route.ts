import type { Organization } from "@repo/api/src/types/organization";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, successResponse } from "@/lib/route-utils";
import { organizationsService } from "./service";

export const GET = withAnyAuth<Organization[], "/organizations">(
  async ({ user }) => {
    try {
      // Users belong to a single organization, so the collection is just the
      // caller's own org (matching the org-scoping in the [id] route).
      const organization = await organizationsService.findDetailById(
        user.organizationId
      );

      return successResponse(organization ? [organization] : []);
    } catch (error) {
      return errorResponse("Failed to fetch organizations", error);
    }
  }
);
