import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveArtifactId } from "@/lib/identifier-utils";
import { notFoundResponse, successResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAuth<ExecutionTrace, "/artifacts/[id]/execution-log">(
  async ({ user }, _request, params) => {
    const { id } = await params;
    const resolvedId = await resolveArtifactId(id, user.organizationId);
    if (!resolvedId) {
      return notFoundResponse("Artifact");
    }

    const trace = await artifactsService.getExecutionLog(
      resolvedId,
      user.organizationId
    );

    return successResponse(trace);
  }
);
