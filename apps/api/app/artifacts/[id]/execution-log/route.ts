import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import { withAuth } from "@/lib/auth/with-auth";
import { successResponse } from "@/lib/route-utils";
import { artifactsService } from "../../service";

export const GET = withAuth<ExecutionTrace, "/artifacts/[id]/execution-log">(
  async ({ user }, _request, params) => {
    const { id } = await params;

    const trace = await artifactsService.getExecutionLog(
      id,
      user.organizationId
    );

    const response = successResponse(trace);
    // Cache for 5 minutes (private cache for authenticated user)
    response.headers.set("Cache-Control", "private, max-age=300");
    return response;
  }
);
