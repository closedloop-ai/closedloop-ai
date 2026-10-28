import { OperationKind } from "@repo/api/src/types/attribution-evidence";
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
  conflictResponse,
  deleteResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import {
  DuplicateNameError,
  EntityNotFoundError,
  tagService,
} from "../service";
import { updateTagValidator } from "../validators";

export const PATCH = withAnyAuth(
  withOperationReceipts<UpdatedTag, "/tags/[id]">(
    OperationKind.OrganizationWrite,
    async ({ user }, request, params, receipts) => {
      try {
        const { id } = await params;
        const { body, errorResponse: parseError } = await parseBody(
          request,
          updateTagValidator
        );
        if (parseError) {
          return parseError;
        }

        const tag = await tagService.update(
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
        return successResponse(withOperationReceipt(tag, receipts));
      } catch (error) {
        if (error instanceof EntityNotFoundError) {
          return notFoundResponse("Tag");
        }
        if (error instanceof DuplicateNameError) {
          return conflictResponse("Tag with this name already exists");
        }
        return errorResponse("Failed to update tag", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

export const DELETE = withAnyAuth(
  withOperationReceipts<{ deleted: true }, "/tags/[id]">(
    OperationKind.OrganizationWrite,
    async ({ user }, _, params, receipts) => {
      try {
        const { id } = await params;
        await tagService.delete(
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
        if (error instanceof EntityNotFoundError) {
          return notFoundResponse("Tag");
        }
        return errorResponse("Failed to delete tag", error);
      }
    }
  ),
  { requiredScopes: ["delete"] }
);

type UpdatedTag = Awaited<ReturnType<typeof tagService.update>>;
