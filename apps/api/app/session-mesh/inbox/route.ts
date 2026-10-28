import {
  badRequestResponse,
  errorResponse,
  successResponse,
} from "@/lib/route-utils";
import { withSessionMeshAuth } from "../auth";
import { sessionMeshService } from "../service";
export const GET = withSessionMeshAuth(async ({ user }, request) => {
  try {
    const agentId = request.nextUrl.searchParams.get("agentId")?.trim();
    if (!agentId) {
      return badRequestResponse("agentId is required");
    }
    return successResponse({
      messages: await sessionMeshService.inbox({
        organizationId: user.organizationId,
        userId: user.id,
        agentId,
      }),
    });
  } catch (error) {
    return errorResponse("Failed to read Session Mesh inbox", error);
  }
});
