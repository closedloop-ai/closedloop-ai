import type { ClaudeCodeTelemetryResponse } from "@repo/api/src/types/claude-code-telemetry";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  type IdRouteParams,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";
import { claudeCodeTelemetryReadService } from "./service";

/**
 * ISS-10717 — `GET /agent-sessions/{id}/claude-code-telemetry`.
 *
 * The read contract for the synced `claude_code_*` corpus. Answers for EVERY
 * session, including one whose harness produces none of these signals: that
 * case returns `availability: "absent_by_harness"` with empty readings and a
 * 200, because nothing failed. A 404 here means the session is not visible to
 * this org, which is the same answer it gives for one that does not exist.
 *
 * Access mirrors the session detail route: org-scoping is the boundary.
 */
export const GET = withAnyAuth<
  ClaudeCodeTelemetryResponse,
  "/agent-sessions/[id]/claude-code-telemetry"
>(async ({ user }, _request, params) => {
  const { id } = (await params) as Awaited<IdRouteParams["params"]>;
  if (!isUuid(id)) {
    return notFoundResponse("Agent session");
  }
  const telemetry =
    await claudeCodeTelemetryReadService.findClaudeCodeTelemetry({
      id,
      organizationId: user.organizationId,
    });
  if (!telemetry) {
    return notFoundResponse("Agent session");
  }
  return successResponse(telemetry);
});
