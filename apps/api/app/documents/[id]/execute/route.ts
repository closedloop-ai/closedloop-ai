import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { resolveDocumentId } from "@/lib/identifier-utils";
import { errorResponse, notFoundResponse } from "@/lib/route-utils";
import { documentsService, type ExecuteResult } from "../../service";

type ExecuteResponse = ExecuteResult;

export const POST = withAuth<ExecuteResponse, "/documents/[id]/execute">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;
      const resolvedId = await resolveDocumentId(id, user.organizationId);
      if (!resolvedId) {
        return notFoundResponse("Artifact");
      }

      const result = await documentsService.executeImplementationPlan(
        resolvedId,
        user.organizationId,
        user.id
      );

      if (!result.success) {
        return NextResponse.json(failure(result.error), {
          status: result.status,
        });
      }

      return NextResponse.json(
        success({
          success: true,
          correlationId: result.correlationId,
        })
      );
    } catch (error) {
      return errorResponse("Execution failed", error);
    }
  }
);
