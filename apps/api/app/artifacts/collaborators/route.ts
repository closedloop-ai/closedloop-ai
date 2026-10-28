import {
  type ArtifactCollaboratorBatchResponse,
  artifactCollaboratorBatchQuerySchema,
} from "@repo/api/src/types/artifact-collaborators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  parseQueryParams,
  payloadTooLargeResponse,
  successResponse,
} from "@/lib/route-utils";
import { artifactCollaboratorsService } from "./service";

/** Read one bounded artifact-type page of organization-scoped collaborators. */
export const GET = withAnyAuth<
  ArtifactCollaboratorBatchResponse,
  "/artifacts/collaborators"
>(
  async ({ user }, request) => {
    const { params, errorResponse: queryError } = parseQueryParams(
      request,
      artifactCollaboratorBatchQuerySchema
    );
    if (queryError) {
      return queryError;
    }
    try {
      const result = await artifactCollaboratorsService.readBoundedBatch(
        user.organizationId,
        params
      );
      return result.ok
        ? successResponse(result.value)
        : payloadTooLargeResponse("Failed to fetch collaborators", {
            code: result.error,
          });
    } catch (error) {
      return errorResponse("Failed to fetch collaborators", error);
    }
  },
  { requiredScopes: ["read"] }
);
