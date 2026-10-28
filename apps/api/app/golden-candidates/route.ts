import {
  type GoldenCandidateListResponse,
  goldenCandidateListQuerySchema,
} from "@repo/api/src/types/golden-candidate";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { parseQueryParams, successResponse } from "@/lib/route-utils";
import { goldenCandidatesService } from "./service";

/**
 * Org-scoped golden-dataset CANDIDATE report (`GET /golden-candidates`, FEA-4171).
 *
 * Lists trace comments a human flagged as parsing/data bugs so a human can
 * hand-author `packages/golden-sessions/` oracle entries from them. It ONLY reads
 * and projects flagged comments — it never writes any golden-sessions oracle
 * file; promotion is a human-only action. ISS-8022 retired the session-monitoring
 * gate this read shared with the per-session trace-comment read; it remains
 * org-scoped at the DB layer.
 */
export const GET = withAnyAuth<
  GoldenCandidateListResponse,
  "/golden-candidates"
>(async ({ user }, request) => {
  const { params, errorResponse: parseError } = parseQueryParams(
    request,
    goldenCandidateListQuerySchema
  );
  if (parseError) {
    return parseError;
  }

  const response = await goldenCandidatesService.listAll({
    organizationId: user.organizationId,
    filters: params,
  });
  return successResponse(response);
});
