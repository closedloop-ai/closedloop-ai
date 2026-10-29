import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { machineWriteReceipt } from "@/lib/machine-write-receipt";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { requireCustomFieldsAdmin } from "../../../custom-fields-admin-gate";
import { enumOptionsService } from "../../../enum-options-service";
import { reorderEnumOptionsValidator } from "../../../enum-options-validators";

export const POST = withAnyAuth(
  withOperationReceipts<
    { reordered: true },
    "/custom-fields/[id]/enum-options/reorder"
  >(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, params, receipts) => {
      const denial = await requireCustomFieldsAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { id } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        reorderEnumOptionsValidator
      );
      if (parseError) {
        return parseError;
      }

      try {
        await enumOptionsService.reorderEnumOptions(
          id,
          user.organizationId,
          body.optionIds,
          receipts.whenRecording((tx, { changed }) =>
            receipts.record(
              tx,
              machineWriteReceipt(OperationKind.OrganizationWrite, changed)
            )
          )
        );
        return successResponse(
          withOperationReceipt({ reordered: true as const }, receipts)
        );
      } catch (error) {
        return errorResponse("Failed to reorder enum options", error);
      }
    }
  )
);
