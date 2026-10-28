import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import { sessionMeshDeliveryAckValidator } from "@repo/api/src/types/session-mesh";
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
          sessionMeshDeliveryAckValidator
        );
        if (parseError) {
          return parseError;
        }
        const result = await sessionMeshService.acknowledge(
          {
            organizationId: user.organizationId,
            userId: user.id,
            ack: body,
          },
          recordSessionMeshWrite(receipts)
        );
        return successResponse(
          withOperationReceipt({ acknowledged: result.count }, receipts)
        );
      } catch (error) {
        return errorResponse(
          "Failed to acknowledge Session Mesh deliveries",
          error
        );
      }
    }
  ),
  { requiredScopes: ["write"] }
);
