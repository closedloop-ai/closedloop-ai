import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { machineWriteReceipt } from "@/lib/machine-write-receipt";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  conflictResponse,
  errorResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { requireCustomFieldsAdmin } from "./custom-fields-admin-gate";
import { customFieldsService, DuplicateNameError } from "./service";
import { ReservedNameError } from "./utils";
import { createCustomFieldValidator } from "./validators";

/**
 * GET /custom-fields - List all custom field definitions for the organization
 */
export const GET = withAnyAuth<CustomFieldWithOptions[], "/custom-fields">(
  async ({ user }) => {
    try {
      const fields = await customFieldsService.findByOrg(user.organizationId);
      return successResponse(fields);
    } catch (error) {
      return errorResponse("Failed to fetch custom fields", error);
    }
  }
);

/**
 * POST /custom-fields - Create a new custom field definition (org admins only)
 */
export const POST = withAnyAuth(
  withOperationReceipts<CustomFieldWithOptions, "/custom-fields">(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, _params, receipts) => {
      try {
        const denial = await requireCustomFieldsAdmin(clerkOrgId, clerkUserId);
        if (denial) {
          return denial;
        }

        const { body, errorResponse: parseError } = await parseBody(
          request,
          createCustomFieldValidator
        );
        if (parseError) {
          return parseError;
        }

        const field = await customFieldsService.createField(
          user.organizationId,
          user.id,
          body,
          receipts.whenRecording((tx) =>
            receipts.record(
              tx,
              machineWriteReceipt(OperationKind.OrganizationWrite, true)
            )
          )
        );

        return successResponse(withOperationReceipt(field, receipts));
      } catch (error) {
        if (error instanceof DuplicateNameError) {
          return conflictResponse("Custom field with this name already exists");
        }
        if (error instanceof ReservedNameError) {
          return conflictResponse(error.message);
        }
        return errorResponse("Failed to create custom field", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
