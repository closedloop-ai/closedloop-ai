import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { BranchRefreshResponse } from "@repo/api/src/types/branch";
import { BranchRefreshReason } from "@repo/api/src/types/branch";
import { branchReadService } from "@/app/branches/branch-read-service";
import { branchRefreshReceiptWrite } from "@/app/branches/branch-refresh-receipt";
import { branchTagPermissionsForAuth } from "@/app/branches/branch-tag-projection";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  notFoundResponse,
  successResponse,
} from "@/lib/route-utils";

export const POST = withAnyAuth<
  BranchRefreshResponse,
  "/branches/[id]/refresh"
>(
  withOperationReceipts(
    OperationKind.UpdateFields,
    async (authContext, _, params, receipts) => {
      const { user, authMethod } = authContext;
      try {
        const { id } = await params;
        const response = await branchReadService.refreshBranch(
          user.organizationId,
          id,
          {
            userId: user.id,
            authMethod,
            tagPermissions: branchTagPermissionsForAuth(authContext),
          },
          receipts.whenRecording((tx) =>
            receipts.record(tx, branchRefreshReceiptWrite(id))
          )
        );
        if (response.reason === BranchRefreshReason.NotFound) {
          return notFoundResponse("Branch");
        }
        const headers = new Headers();
        if (response.retryAfterSeconds) {
          headers.set("Retry-After", String(response.retryAfterSeconds));
        }
        const json = successResponse(withOperationReceipt(response, receipts));
        for (const [key, value] of headers) {
          json.headers.set(key, value);
        }
        return json;
      } catch (error) {
        return errorResponse("Failed to refresh branch", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
