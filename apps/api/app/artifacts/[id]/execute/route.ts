import { failure, success } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse } from "@/lib/route-utils";
import { artifactsService, type ExecuteResult } from "../../service";

type ExecuteResponse = ExecuteResult;

export const POST = withAuth<ExecuteResponse, "/artifacts/[id]/execute">(
  async ({ user }, _request, params) => {
    try {
      const { id } = await params;

      const result = await artifactsService.executeImplementationPlan(
        id,
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
