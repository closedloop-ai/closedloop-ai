import type { Organization } from "@repo/api/src/types/organization";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { updateOrganizationSchema } from "../schemas";
import { organizationsService } from "../service";

export const GET = withAuth<Organization, "/organizations/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;

      // Users can only fetch their own organization
      if (id !== user.organizationId) {
        return forbiddenResponse();
      }

      const organization = await organizationsService.findById(id);

      if (!organization) {
        return notFoundResponse("Organization");
      }

      return successResponse(organization as Organization);
    } catch (error) {
      return errorResponse("Failed to fetch organization", error);
    }
  }
);

export const PUT = withAuth<Organization, "/organizations/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;

      // Users can only update their own organization
      if (id !== user.organizationId) {
        return forbiddenResponse();
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateOrganizationSchema
      );
      if (parseError) {
        return parseError;
      }

      const organization = await organizationsService.update(id, body);

      return successResponse(organization as Organization);
    } catch (error) {
      return errorResponse("Failed to update organization", error);
    }
  }
);
