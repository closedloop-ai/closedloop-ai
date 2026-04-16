import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { notFoundResponse, successResponse } from "@/lib/route-utils";
import { documentsService } from "../../service";

export const GET = withAuth<ExecutionTrace, "/documents/[id]/execution-log">(
  async ({ user }, _request, params) => {
    const { id } = await params;
    const resolvedId = await resolveDocumentId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const trace = await documentsService.getExecutionLog(
      resolvedId,
      user.organizationId
    );

    return successResponse(trace);
  }
);
