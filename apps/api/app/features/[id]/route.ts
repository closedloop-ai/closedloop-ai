import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveFeatureId, resolveProjectId } from "@/lib/identifier-utils";

import {
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  applyCustomFieldsFromBody,
  mergeCustomFieldsIntoResponse,
} from "../../custom-fields/route-helpers";
import { featuresService } from "../service";
import { updateFeatureValidator } from "../validators";

export const GET = withAnyAuth<FeatureWithWorkstream, "/features/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveFeatureId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Feature");
      }

      const feature = await featuresService.findById(
        resolvedId,
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

export const PUT = withAnyAuth<FeatureWithWorkstream, "/features/[id]">(
  async ({ user }, request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveFeatureId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Feature");
      }

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateFeatureValidator
      );
      if (parseError) {
        return parseError;
      }

      const { customFields, ...featureInput } = body;

      if (featureInput.projectId) {
        const pId = await resolveProjectId(
          featureInput.projectId,
          user.organizationId
        );
        if (!pId) {
          return notFoundResponse("Project");
        }
        featureInput.projectId = pId;
      }

      const feature = await featuresService.update(
        resolvedId,
        user.organizationId,
        featureInput
      );

      if (customFields) {
        await applyCustomFieldsFromBody(
          customFields,
          resolvedId,
          CustomFieldEntityType.Feature,
          user.organizationId
        );
      }

      return successResponse(feature);
    } catch (error) {
      return errorResponse("Failed to update feature", error);
    }
  },
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth<{ deleted: true }, "/features/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveFeatureId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Feature");
      }

      await featuresService.delete(resolvedId, user.organizationId);
      return deleteResponse();
    } catch (error) {
      return errorResponse("Failed to delete feature", error);
    }
  },
  { requiredScopes: ["delete"] }
);
