import type { ProjectArtifactBoardPageResponse } from "@repo/api/src/types/project-artifact-board-page";
import { Status } from "@repo/api/src/types/result";
import { projectArtifactBoardPageService } from "@/app/artifacts/project-artifact-board-page-service";
import {
  resolveBoardStatusEvidence,
  resolveBoardStatusOrdering,
} from "@/app/artifacts/project-artifact-board-status-evidence";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { projectArtifactBoardRouteQueryValidator } from "./board-query";

/** Return stable lane metadata and one deterministic cursor page per lane. */
export const GET = withAnyAuth<
  ProjectArtifactBoardPageResponse,
  "/projects/[id]/artifacts/board"
>(async ({ user }, request, params) => {
  try {
    const { id: projectIdentifier } = await params;
    const projectId = await resolveProjectId(
      projectIdentifier,
      user.organizationId
    );
    if (!projectId) {
      return notFoundResponse("Project");
    }
    const parsed = parseQueryParams(
      request,
      projectArtifactBoardRouteQueryValidator
    );
    if (parsed.errorResponse) {
      return badRequestResponse("Invalid project artifact board query");
    }
    // `clerkUserId` buckets a percentage rollout the way the browser does
    // (`lib/feature-flag-identity.ts`, ISS-8196).
    const identity = { clerkUserId: user.clerkId, userId: user.id };
    const [statusEvidence, statusOrdering] = await Promise.all([
      resolveBoardStatusEvidence(identity, parsed.params.filters),
      resolveBoardStatusOrdering(identity, parsed.params.sortBy),
    ]);
    const result = await projectArtifactBoardPageService.read(
      projectId,
      user.organizationId,
      parsed.params,
      { statusEvidence, statusOrdering, userId: user.id }
    );
    if (result.ok) {
      return successResponse(result.value);
    }
    if (result.error.status === Status.Conflict) {
      return conflictResponse(result.error.message, {
        code: result.error.code,
      });
    }
    return badRequestResponse(result.error.message);
  } catch (error) {
    return errorResponse("Failed to fetch project artifact board", error);
  }
});
