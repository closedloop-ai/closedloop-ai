import type {
  RegisterComputeTargetInput,
  RegisterComputeTargetResponse,
} from "@repo/api/src/types/compute-target";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import {
  ComputeTargetGatewayConflictError,
  computeTargetsService,
} from "../service";
import { registerComputeTargetValidator } from "../validators";

/**
 * POST /compute-targets/register
 * Registers or updates a compute target for the authenticated user.
 */
export const POST = withAnyAuth<
  RegisterComputeTargetResponse,
  "/compute-targets/register"
>(async ({ user }, request) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      registerComputeTargetValidator
    );

    if (parseError || !body) {
      return parseError;
    }

    const target = await computeTargetsService.register(
      user.organizationId,
      user.id,
      body as RegisterComputeTargetInput
    );

    return successResponse({
      id: target.id,
      machineName: target.machineName,
      isOnline: true,
    });
  } catch (error) {
    if (error instanceof ComputeTargetGatewayConflictError) {
      return NextResponse.json(
        {
          success: false,
          error: "Desktop gateway identity is already bound to another target",
        },
        { status: 409 }
      );
    }
    return errorResponse("Failed to register compute target", error);
  }
});
