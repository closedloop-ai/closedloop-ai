import type {
  Artifact,
  ArtifactWithWorkstream,
} from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  resolveEntityLinkIdentifier,
  resolveProjectId,
  resolveWorkstreamId,
} from "@/lib/identifier-utils";
import { scheduleAutoEvaluatePrd } from "@/lib/loops/auto-evaluate-prd";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { customFieldValuesService } from "../custom-fields/values-service";
import { artifactsService } from "./service";
import {
  createArtifactValidator,
  findArtifactsQueryValidator,
} from "./validators";

/**
 * GET /artifacts - List artifacts
 * Accepts API key authentication (sk_live_) or Clerk session authentication.
 */
export const GET = withAnyAuth<ArtifactWithWorkstream[], "/artifacts">(
  async ({ user }, request) => {
    try {
      const searchParams = request.nextUrl.searchParams;

      // Convert searchParams to plain object for validation
      const queryParams = Object.fromEntries(searchParams.entries());

      // Validate query parameters
      const parseResult = findArtifactsQueryValidator.safeParse(queryParams);

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

      const artifacts = await artifactsService.findAll({
        organizationId: user.organizationId,
        projectId: resolvedProjectId,
        workstreamId: resolvedWorkstreamId,
        ...restQuery,
      });

      // Batch-load custom field values for all artifacts in a single query
      const artifactIds = artifacts.map((a) => a.id);
      const allValues =
        artifactIds.length > 0
          ? await customFieldValuesService.getValuesForEntity(
              CustomFieldEntityType.Artifact,
              artifactIds,
              user.organizationId
            )
          : [];

      const valuesByEntityId = new Map(
        artifacts.map((a) => [a.id, [] as typeof allValues])
      );
      for (const value of allValues) {
        const list = valuesByEntityId.get(value.entityId);
        if (list) {
          list.push(value);
        }
      }

      const artifactsWithFields = artifacts.map((a) => ({
        ...a,
        customFields: valuesByEntityId.get(a.id) ?? [],
      }));

      return successResponse(artifactsWithFields);
    } catch (error) {
      return errorResponse("Failed to fetch artifacts", error);
    }
  }
);

export const POST = withAnyAuth<Artifact, "/artifacts">(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createArtifactValidator
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
      let resolvedSourceId: string | undefined;
      if (body.sourceId && body.sourceType) {
        const sId = await resolveEntityLinkIdentifier(
          body.sourceId,
          user.organizationId,
          body.sourceType
        );
        if (!sId) {
          return notFoundResponse("Source entity");
        }
        resolvedSourceId = sId;
      }

      const artifact = await artifactsService.create(
        user.organizationId,
        user.id,
        {
          ...body,
          projectId: resolvedProjectId,
          workstreamId: resolvedWorkstreamId,
          sourceId: resolvedSourceId,
        }
      );
      if (!artifact) {
        return badRequestResponse("Failed to create artifact");
      }

      if (artifact.type === ArtifactType.Prd) {
        scheduleAutoEvaluatePrd(artifact.id, user.organizationId, user.id);
      }

      return successResponse(artifact);
    } catch (error) {
      return errorResponse("Failed to create artifact", error);
    }
  },
  { requiredScopes: ["write"] }
);
