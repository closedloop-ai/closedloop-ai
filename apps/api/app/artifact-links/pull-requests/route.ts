import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { pullRequestArtifactLinkService } from "./pull-request-artifact-service";
import type { CreatePrArtifactResponse } from "./route-contract";
import { createPrArtifactValidator } from "./route-contract";
import { createPullRequestArtifactErrorResponse } from "./route-response";

/**
 * POST /artifact-links/pull-requests
 *
 * Deprecated compatibility alias for callers that still submit a PR-shaped
 * payload. The route now materializes a BRANCH artifact and stores the PR as
 * optional current detail, so compatibility clients do not create legacy
 * PULL_REQUEST artifacts.
 *
 * The repositoryId is derived server-side from the project's default
 * repository setting so the client doesn't have to thread it through.
 */
export const POST = withAnyAuth<
  CreatePrArtifactResponse,
  "/artifact-links/pull-requests"
>(
  async ({ user }, request) => {
    try {
      const { body, errorResponse: parseError } = await parseBody(
        request,
        createPrArtifactValidator
      );
      if (parseError) {
        return parseError;
      }

      const result =
        await pullRequestArtifactLinkService.createPullRequestArtifact({
          body,
          createdById: user.id,
          organizationId: user.organizationId,
        });
      if (!result.ok) {
        return createPullRequestArtifactErrorResponse(result.error);
      }

      return successResponse({ id: result.value.id });
    } catch (error) {
      return errorResponse("Failed to create pull request artifact", error);
    }
  },
  { requiredScopes: ["write"] }
);
