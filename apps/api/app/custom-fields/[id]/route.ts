import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { CustomFieldWithOptions } from "@repo/api/src/types/custom-field";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  machineUpdateReceipt,
  machineWriteReceipt,
} from "@/lib/machine-write-receipt";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  conflictResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { requireCustomFieldsAdmin } from "../custom-fields-admin-gate";
import {
  customFieldsService,
  DuplicateNameError,
  IncompatibleNumberFormatError,
  IncompatibleReferenceSourcesError,
} from "../service";
import { ReservedNameError } from "../utils";
import { updateCustomFieldValidator } from "../validators";

/**
 * GET /custom-fields/:id - Get a single custom field definition by ID
 */
export const GET = withAnyAuth<CustomFieldWithOptions, "/custom-fields/[id]">(
  async ({ user }, _, params) => {
    try {
      const { id } = await params;
      const field = await customFieldsService.findById(id, user.organizationId);

      if (!field) {
        return notFoundResponse("Custom field");
      }

      return successResponse(field);
    } catch (error) {
      return errorResponse("Failed to fetch custom field", error);
    }
  }
);

/**
 * PUT /custom-fields/:id - Update a custom field definition (org admins only)
 */
export const PUT = withAnyAuth(
  withOperationReceipts<CustomFieldWithOptions, "/custom-fields/[id]">(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, request, params, receipts) => {
      try {
        const denial = await requireCustomFieldsAdmin(clerkOrgId, clerkUserId);
        if (denial) {
          return denial;
        }

        const { id } = await params;
        const { body, errorResponse: parseError } = await parseBody(
          request,
          updateCustomFieldValidator
        );
        if (parseError) {
          return parseError;
        }

        const field = await customFieldsService.findById(
          id,
          user.organizationId
        );
        if (!field) {
          return notFoundResponse("Custom field");
        }

        const updated = await customFieldsService.updateField(
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

        return successResponse(withOperationReceipt(updated, receipts));
      } catch (error) {
        if (error instanceof DuplicateNameError) {
          return conflictResponse("Custom field with this name already exists");
        }
        if (error instanceof ReservedNameError) {
          return conflictResponse(error.message);
        }
        if (error instanceof IncompatibleNumberFormatError) {
          return badRequestResponse(error.message);
        }
        if (error instanceof IncompatibleReferenceSourcesError) {
          return badRequestResponse(error.message);
        }
        return errorResponse("Failed to update custom field", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

/**
 * DELETE /custom-fields/:id - Delete a custom field definition (org admins only)
 */
export const DELETE = withAnyAuth(
  withOperationReceipts<{ deleted: true }, "/custom-fields/[id]">(
    OperationKind.OrganizationWrite,
    async ({ user, clerkOrgId, clerkUserId }, _, params, receipts) => {
      try {
        const denial = await requireCustomFieldsAdmin(clerkOrgId, clerkUserId);
        if (denial) {
          return denial;
        }

        const { id } = await params;

        const field = await customFieldsService.findById(
          id,
          user.organizationId
        );
        if (!field) {
          return notFoundResponse("Custom field");
        }

        await customFieldsService.deleteField(
          id,
          user.organizationId,
          receipts.whenRecording((tx) =>
            receipts.record(
              tx,
              machineWriteReceipt(OperationKind.OrganizationWrite, true)
            )
          )
        );
        return deleteResponse(receipts.receipt);
      } catch (error) {
        return errorResponse("Failed to delete custom field", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);
