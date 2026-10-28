import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CustomFieldEnumOption } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { machineUpdateReceipt } from "@/lib/machine-write-receipt";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { requireCustomFieldsAdmin } from "../../../custom-fields-admin-gate";
import { enumOptionsService } from "../../../enum-options-service";
import { updateEnumOptionValidator } from "../../../enum-options-validators";

export const PUT = withAnyAuth(
  withOperationReceipts<
    CustomFieldEnumOption,
    "/custom-fields/[id]/enum-options/[optionId]"
  >(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, params, receipts) => {
      const denial = await requireCustomFieldsAdmin(clerkOrgId, clerkUserId);
      if (denial) {
        return denial;
      }

      const { id, optionId } = await params;

      const { body, errorResponse: parseError } = await parseBody(
        request,
        updateEnumOptionValidator
      );
      if (parseError) {
        return parseError;
      }

      try {
        const option = await enumOptionsService.updateEnumOption(
          optionId,
          id,
          user.organizationId,
          body,
          receipts.whenRecording((tx, { changedFields }) =>
            receipts.record(
              tx,
              machineUpdateReceipt(
                OperationKind.OrganizationWrite,
                changedFields
              )
            )
          )
        );
        return successResponse(withOperationReceipt(option, receipts));
      } catch (error) {
        return errorResponse("Failed to update enum option", error);
      }
    }
  )
);
