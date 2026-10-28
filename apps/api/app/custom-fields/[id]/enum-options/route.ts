import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CustomFieldEnumOption } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { machineWriteReceipt } from "@/lib/machine-write-receipt";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { requireCustomFieldsAdmin } from "../../custom-fields-admin-gate";
import { enumOptionsService } from "../../enum-options-service";
import { createEnumOptionValidator } from "../../enum-options-validators";
import { customFieldsService } from "../../service";

/**
 * GET /custom-fields/:id/enum-options - List enum options for a custom field
 */
export const GET = withAnyAuth<
  CustomFieldEnumOption[],
  "/custom-fields/[id]/enum-options"
>(async ({ user }, _, params) => {
  try {
    const { id } = await params;
    const field = await customFieldsService.findById(id, user.organizationId);

    if (!field) {
      return notFoundResponse("Custom field");
    }

    return successResponse(field.enumOptions);
  } catch (error) {
    return errorResponse("Failed to fetch enum options", error);
  }
});

export const POST = withAnyAuth(
  withOperationReceipts<
    CustomFieldEnumOption,
    "/custom-fields/[id]/enum-options"
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
        createEnumOptionValidator
      );
      if (parseError) {
        return parseError;
      }

      try {
        const option = await enumOptionsService.createEnumOption(
          id,
          user.organizationId,
          body,
          receipts.whenRecording((tx) =>
            receipts.record(
              tx,
              machineWriteReceipt(OperationKind.OrganizationWrite, true)
            )
          )
        );
        return successResponse(withOperationReceipt(option, receipts));
      } catch (error) {
        return errorResponse("Failed to create enum option", error);
      }
    }
  )
);
