import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { withAuth } from "@/lib/auth/with-auth";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { mergeCustomFieldsIntoResponse } from "../../../custom-fields/route-helpers";
import { featuresService } from "../../service";

export const GET = withAuth<FeatureWithWorkstream, "/features/by-slug/[slug]">(
  async ({ user }, _, params) => {
    try {
      const { slug } = await params;

      const feature = await featuresService.findBySlug(
        slug,
        user.organizationId
      );

      if (!feature) {
        return notFoundResponse("Feature");
      }

      const response = await mergeCustomFieldsIntoResponse(
        feature,
        CustomFieldEntityType.Feature,
        user.organizationId
      );

      return successResponse(response);
    } catch (error) {
      return errorResponse("Failed to fetch feature", error);
    }
  }
);
