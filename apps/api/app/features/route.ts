import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId, resolveWorkstreamId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldValuesService } from "../custom-fields/values-service";
import { featuresService } from "./service";
import {
  createFeatureValidator,
  findFeaturesQueryValidator,
} from "./validators";

export const GET = withAnyAuth<FeatureWithWorkstream[], "/features">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;

      // Convert searchParams to plain object for validation
      const queryParams = Object.fromEntries(searchParams.entries());

      // Validate query parameters
      const parseResult = findFeaturesQueryValidator.safeParse(queryParams);

      if (!parseResult.success) {
        return badRequestResponse(
          `Invalid query parameters: ${parseResult.error.message}`
        );
      }

      const { projectId, workstreamId, ...restQuery } = parseResult.data;
      let resolvedProjectId: string | undefined;
      if (projectId) {
        const pId = await resolveProjectId(projectId, user.organizationId);
        if (!pId) {
          return notFoundResponse("Project");
        }
        resolvedProjectId = pId;
      }
      let resolvedWorkstreamId: string | undefined;
      if (workstreamId) {
        const wId = await resolveWorkstreamId(
          workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
      }

      const features = await featuresService.findAll({
        organizationId: user.organizationId,
        projectId: resolvedProjectId,
        workstreamId: resolvedWorkstreamId,
        ...restQuery,
      });

      // Batch-load custom field values for all features in a single query
      const featureIds = features.map((f) => f.id);
      const allValues =
        featureIds.length > 0
          ? await customFieldValuesService.getValuesForEntity(
              CustomFieldEntityType.Feature,
              featureIds,
              user.organizationId
            )
          : [];

      const valuesByEntityId = new Map(
        features.map((f) => [f.id, [] as typeof allValues])
      );
      for (const value of allValues) {
        const list = valuesByEntityId.get(value.entityId);
        if (list) {
          list.push(value);
        }
      }

      const featuresWithFields = features.map((f) => ({
        ...f,
        customFields: valuesByEntityId.get(f.id) ?? [],
      }));

      return successResponse(featuresWithFields);
    } catch (error) {
      return errorResponse("Failed to fetch features", error);
    }
  }
);

export const POST = withAnyAuth<FeatureWithWorkstream, "/features">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createFeatureValidator
      );
      if (parseError) {
        return parseError;
      }

      const resolvedProjectId = await resolveProjectId(
        body.projectId,
        user.organizationId
      );
      if (!resolvedProjectId) {
        return notFoundResponse("Project");
      }
      let resolvedWorkstreamId: string | undefined;
      if (body.workstreamId) {
        const wId = await resolveWorkstreamId(
          body.workstreamId,
          user.organizationId
        );
        if (!wId) {
          return notFoundResponse("Workstream");
        }
        resolvedWorkstreamId = wId;
      }

      const feature = await featuresService.create(user.organizationId, user.id, {
        ...body,
        projectId: resolvedProjectId,
        workstreamId: resolvedWorkstreamId,
      });
      if (!feature) {
        return badRequestResponse("Failed to create feature");
      }

      return successResponse(feature);
    } catch (error) {
      return errorResponse("Failed to create feature", error);
    }
  },
  { requiredScopes: ["write"] }
);
