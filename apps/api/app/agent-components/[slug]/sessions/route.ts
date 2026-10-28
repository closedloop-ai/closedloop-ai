import type { AgentComponentSessionsPage } from "@repo/api/src/types/agent-component-detail-page";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  errorResponse,
  notFoundResponse,
  parseQueryParams,
  successResponse,
} from "@/lib/route-utils";
import { decodeSessionTabCursor } from "../../component-detail-cursor";
import { sessionsPageQuerySchema } from "../../detail-page-validators";
import { agentComponentsService } from "../../service";

export const GET = withAnyAuth<
  AgentComponentSessionsPage,
  "/agent-components/[slug]/sessions"
>(
  async ({ user }, request, params) => {
    const { params: query, errorResponse: parseError } = parseQueryParams(
      request,
      sessionsPageQuerySchema
    );
    if (parseError) {
      return parseError;
    }
    try {
      const { slug } = await params;
      const detail = await agentComponentsService.getDetailForOrg(
        user.organizationId,
        slug,
        { userId: user.id, clerkUserId: user.clerkId },
        {
          sessionCursor: query.cursor
            ? (decodeSessionTabCursor(query.cursor) ?? undefined)
            : undefined,
        }
      );
      if (!detail) {
        return notFoundResponse("AgentComponent");
      }
      const page = {
        items: detail.sessionsTab,
        total: detail.sessions,
        nextCursor: detail.sessionsTabNextCursor ?? null,
      };
      return successResponse(page);
    } catch (error) {
      return errorResponse("Failed to fetch agent component", error);
    }
  },
  { requiredScopes: ["read"] }
);
