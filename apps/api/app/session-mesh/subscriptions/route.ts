import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { sessionMeshSubscriptionValidator } from "@repo/api/src/types/session-mesh";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import { errorResponse, parseBody, successResponse } from "@/lib/route-utils";
import { withSessionMeshAuth } from "../auth";
import { recordSessionMeshWrite } from "../mesh-write-receipt";
import { sessionMeshService } from "../service";
export const POST = withSessionMeshAuth(
  withOperationReceipts(
    OperationKind.SessionMeshWrite,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          sessionMeshSubscriptionValidator
        );
        if (parseError) {
          return parseError;
        }
        const subscription = await sessionMeshService.upsertSubscription(
          {
            organizationId: user.organizationId,
            userId: user.id,
            ...body,
          },
          recordSessionMeshWrite(receipts)
        );
        return successResponse(
          withOperationReceipt({ subscription }, receipts)
        );
      } catch (error) {
        return errorResponse(
          "Failed to update Session Mesh subscription",
          error
        );
      }
    }
  ),
  { requiredScopes: ["write"] }
);
