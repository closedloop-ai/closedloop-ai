import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type {
  RegisterComputeTargetInput,
  RegisterComputeTargetResponse,
} from "@repo/api/src/types/compute-target";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { recordOrganizationWrite } from "@/lib/organization-write-receipt";
import {
  conflictResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  computeTargetsService,
  isComputeTargetGatewayConflictResult,
} from "../service";
import { registerComputeTargetValidator } from "../validators";

/**
 * POST /compute-targets/register
 * Registers or updates a compute target for the authenticated user.
 */
export const POST = withAnyAuth<
  RegisterComputeTargetResponse,
  "/compute-targets/register"
>(
  withOperationReceipts(
    OperationKind.OrganizationWrite,
    async ({ user }, request, _params, receipts) => {
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
          body as RegisterComputeTargetInput,
          recordOrganizationWrite(receipts)
        );

        if (isComputeTargetGatewayConflictResult(target)) {
          return conflictResponse(
            "Desktop gateway identity is already bound to another target"
          );
        }

        return successResponse(
          withOperationReceipt(
            {
              id: target.value.id,
              machineName: target.value.machineName,
              isOnline: true,
            },
            receipts
          )
        );
      } catch (error) {
        return errorResponse("Failed to register compute target", error);
      }
    }
  )
);
