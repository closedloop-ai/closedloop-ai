import { z } from "zod";
import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { withSessionMeshAuth } from "../auth";
import { sessionMeshService } from "../service";

/** Bounded native context command: related peers plus receipt history. */
export const GET = withSessionMeshAuth(async ({ user }, request) => {
  try {
    const suppliedAgentId = request.nextUrl.searchParams.get("agentId")?.trim();
    const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim();
    const cursors = z
      .object({
        cursor: z.string().min(1).max(500).optional(),
        inboxCursor: z.string().uuid().optional(),
      })
      .safeParse({
        cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
        inboxCursor:
          request.nextUrl.searchParams.get("inboxCursor") ?? undefined,
      });
    if (!cursors.success) {
      return badRequestResponse("Invalid coordination cursor");
    }
    const revision =
      request.nextUrl.searchParams.get("revision")?.trim() || undefined;
    const current = await sessionMeshService.resolveCurrentPresence({
      organizationId: user.organizationId,
      userId: user.id,
      agentId: suppliedAgentId,
      sessionId,
    });
    if (!current) {
      return badRequestResponse(
        "A current owned Session Mesh agentId or sessionId is required"
      );
    }
    const [roster, inbox, subscription] = await Promise.all([
      // Revision is intentionally optional: cross-branch same-file work is a
      // conflict candidate. Omitting it stays repository-scoped, never org-wide.
      sessionMeshService.rosterPage(
        user.organizationId,
        {
          repository: current.repository,
          revision,
        },
        cursors.data.cursor
      ),
      // Explicit context lookup includes delivered/acknowledged history;
      // automatic native polling remains pending-only.
      sessionMeshService.deliveryHistoryPage({
        organizationId: user.organizationId,
        userId: user.id,
        agentId: current.agentId,
        cursor: cursors.data.inboxCursor,
      }),
      sessionMeshService.subscription({
        organizationId: user.organizationId,
        userId: user.id,
        repository: current.repository,
      }),
    ]);
    return successResponse({
      currentAgentId: current.agentId,
      currentWorkspace: {
        repository: current.repository,
        revision: current.revision,
      },
      roster: roster.agents,
      inbox: inbox.messages,
      ...(roster.nextCursor ? { nextRosterCursor: roster.nextCursor } : {}),
      ...(inbox.nextCursor ? { nextInboxCursor: inbox.nextCursor } : {}),
      subscription,
    });
  } catch (error) {
    return errorResponse("Failed to read related Session Mesh work", error);
  }
});
