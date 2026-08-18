import {
  type GoldenCandidateListResponse,
  goldenCandidateListQuerySchema,
} from "@repo/api/src/types/golden-candidate";
import { getAgentSessionViewerScope } from "@/app/agent-sessions/route-helpers";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  forbiddenResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { goldenCandidatesService } from "./service";

/**
 * Org-scoped golden-dataset CANDIDATE report (`GET /golden-candidates`, FEA-4171).
 *
 * Lists trace comments a human flagged as parsing/data bugs so a human can
 * hand-author `packages/golden-sessions/` oracle entries from them. It ONLY reads
 * and projects flagged comments — it never writes any golden-sessions oracle
 * file; promotion is a human-only action. Gated on the same session-monitoring
 * scope as the per-session trace-comment read, since candidates are derived from
 * session comments, and org-scoped at the DB layer.
 */
export const GET = withAnyAuth<
  GoldenCandidateListResponse,
  "/golden-candidates"
>(async ({ user, clerkUserId }, request) => {
  const { params, errorResponse: parseError } = parseQueryParams(
    request,
    goldenCandidateListQuerySchema
  );
  if (parseError) {
    return parseError;
  }

  const viewerScope = await getAgentSessionViewerScope({
    userId: user.id,
    clerkUserId,
  });
  if (!viewerScope.monitoringEnabled) {
    return forbiddenResponse();
  }

  const response = await goldenCandidatesService.listAll({
    organizationId: user.organizationId,
    filters: params,
  });
  return successResponse(response);
});
