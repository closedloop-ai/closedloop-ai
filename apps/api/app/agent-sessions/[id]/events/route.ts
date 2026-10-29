import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  type IdRouteParams,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { agentSessionsService } from "../../service";
import { agentSessionEventsPageQuerySchema } from "../../validators";

/**
 * `GET /agent-sessions/{id}/events` — one keyset page of a session's raw event
 * stream (ISS-9857 / PRD-666), in the same `(createdAt, externalEventId)` order
 * the detail's bounded `events` prefix uses, so a client that was cut off at
 * event 10,000 can continue from the last event it was served.
 *
 * Query params:
 *   `cursor` — a prior page's `nextCursor`, or a cursor minted from the detail
 *              prefix's last event. Anything this endpoint could not have
 *              minted is a 400.
 *   `limit`  — rows per page; the service clamps it into
 *              `SESSION_EVENTS_PAGE_LIMIT_BOUNDS`, so an out-of-range value is a
 *              bounded page, not an error. A present-but-blank `?limit=` is a 400.
 *
 * Access mirrors the session detail route: org-scoping is the boundary, so a
 * session in another organization 404s and no events leak. `nextCursor` is
 * absent on the last page.
 */
export const GET = withAnyAuth<
  AgentSessionEventsPage,
  "/agent-sessions/[id]/events"
>(async ({ user }, request, params) => {
  const { id } = (await params) as Awaited<IdRouteParams["params"]>;
  if (!isUuid(id)) {
    return notFoundResponse("Agent session");
  }
  const { params: query, errorResponse } = parseQueryParams(
    request,
    agentSessionEventsPageQuerySchema
  );
  if (errorResponse) {
    return errorResponse;
  }

  const page = await agentSessionsService.findSessionEventsPage({
    ...query,
    id,
    organizationId: user.organizationId,
  });

  if (!page) {
    return notFoundResponse("Agent session");
  }

  return successResponse(page);
});
