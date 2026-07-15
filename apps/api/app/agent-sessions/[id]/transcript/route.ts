import type { TranscriptAccessResponse } from "@repo/api/src/types/desktop-transcripts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  forbiddenResponse,
  type IdRouteParams,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { getAgentSessionViewerScope } from "../../route-helpers";
import { transcriptReadService } from "../../transcript-read-service";

/**
 * `GET /agent-sessions/{id}/transcript` — authorized read access to a session's
 * archived transcript files (FEA-2716 / PLN-1289). Returns one descriptor per
 * file (main + subagents) with the FR8 availability state and a short-lived
 * signed S3 GET URL for readable files; the browser fetches raw JSONL directly.
 *
 * Access mirrors the session detail route exactly: the same `monitoringEnabled`
 * viewer-scope gate plus org-scoping, so a caller who cannot open the session's
 * detail gets a 404 here too — no transcript content or URL leaks (PRD AC10).
 */
export const GET = withAnyAuth<
  TranscriptAccessResponse,
  "/agent-sessions/[id]/transcript"
>(async ({ user, clerkUserId }, _request, params) => {
  const viewerScope = await getAgentSessionViewerScope({
    userId: user.id,
    clerkUserId,
  });
  if (!viewerScope.monitoringEnabled) {
    return forbiddenResponse();
  }

  const { id } = (await params) as Awaited<IdRouteParams["params"]>;
  const access = await transcriptReadService.findTranscriptAccess({
    id,
    organizationId: user.organizationId,
  });

  if (!access) {
    return notFoundResponse("Agent session");
  }

  return successResponse(access);
});
