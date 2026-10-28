import {
  TRANSCRIPT_ACCESS_FILE_KEY_PARAM,
  type TranscriptAccessResponse,
  transcriptFileKeySchema,
} from "@repo/api/src/types/desktop-transcripts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  type IdRouteParams,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { transcriptReadService } from "../../transcript-read-service";

/**
 * `GET /agent-sessions/{id}/transcript` — authorized read access to a session's
 * archived transcript files (FEA-2716 / PLN-1289). Returns one descriptor per
 * file (main + subagents) with the FR8 availability state and a short-lived
 * signed S3 GET URL for readable files; the browser fetches raw JSONL directly.
 * An optional `?fileKey=` limits the signing to the file the caller is about to
 * read (ISS-12276); absent or unrecognized, every readable file is signed as
 * before, so an older or newer client never loses a read.
 *
 * Access mirrors the session detail route exactly: org-scoping is the boundary,
 * so a transcript for a session in another org 404s and no content or signed URL
 * leaks (PRD AC10). FEA-4155 removed the `monitoringEnabled` flag gate here in
 * lockstep with the detail route so the always-on Sessions surface's transcript
 * reads don't 403 as the winding-down `DESKTOP_AGENT_SESSION_SYNC` flag resolves
 * false.
 */
export const GET = withAnyAuth<
  TranscriptAccessResponse,
  "/agent-sessions/[id]/transcript"
>(async ({ user }, request, params) => {
  const { id } = (await params) as Awaited<IdRouteParams["params"]>;
  if (!isUuid(id)) {
    return notFoundResponse("Agent session");
  }
  const requestedFileKey = transcriptFileKeySchema.safeParse(
    request.nextUrl.searchParams.get(TRANSCRIPT_ACCESS_FILE_KEY_PARAM)
  );
  const access = await transcriptReadService.findTranscriptAccess({
    id,
    organizationId: user.organizationId,
    ...(requestedFileKey.success ? { fileKey: requestedFileKey.data } : {}),
  });

  if (!access) {
    return notFoundResponse("Agent session");
  }

  return successResponse(access);
});
