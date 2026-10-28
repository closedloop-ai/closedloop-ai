import type { AgentComponentInvocationSessionTreePage } from "@repo/api/src/types/agent-component-invocation-session-tree";
import { withDb } from "@repo/database";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { isUuid } from "@/lib/is-uuid";
import {
  errorResponse,
  type IdRouteParams,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { loadAgentSessionInvocationTree } from "../../service/session-invocation-tree-read";
import { agentSessionInvocationTreeQuerySchema } from "../../validators";

/**
 * `GET /agent-sessions/{id}/invocation-tree` -- one keyset page of every
 * agent-component invocation of one session, in canonical session order, for the
 * Trace tab (ISS-10737).
 *
 * Distinct from the component-scoped invocation page, which is capped at 500
 * rows: a session tree clipped at a constant loses parents, so its children
 * re-root and report a WRONG ancestry chain. This read is session-scoped and its
 * page bound is FOLLOWABLE -- `nextCursor` is omitted only at exhaustion -- so a
 * caller reaches the whole population instead of a retained prefix.
 *
 * Access mirrors the session detail route: org-scoping is the boundary, so a
 * session in another organization 404s and no invocation leaks.
 */
export const GET = withAnyAuth<
  AgentComponentInvocationSessionTreePage,
  "/agent-sessions/[id]/invocation-tree"
>(
  async ({ user }, request, params) => {
    const { id } = (await params) as Awaited<IdRouteParams["params"]>;
    if (!isUuid(id)) {
      return notFoundResponse("Agent session");
    }
    const { params: query, errorResponse: queryError } = parseQueryParams(
      request,
      agentSessionInvocationTreeQuerySchema
    );
    if (queryError) {
      return queryError;
    }
    try {
      const page = await withDb((db) =>
        loadAgentSessionInvocationTree(db, {
          sessionId: id,
          organizationId: user.organizationId,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        })
      );
      if (!page) {
        return notFoundResponse("Agent session");
      }
      return successResponse(page);
    } catch (error) {
      return errorResponse("Failed to fetch session invocation tree", error);
    }
  },
  { requiredScopes: ["read"] }
);
