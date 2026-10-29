import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  SessionMeshForbiddenCode,
  sessionMeshFeedbackValidator,
} from "@repo/api/src/types/session-mesh";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
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
          sessionMeshFeedbackValidator
        );
        if (parseError) {
          return parseError;
        }
        const result = await sessionMeshService.recordFeedback(
          {
            organizationId: user.organizationId,
            userId: user.id,
            ...body,
          },
          recordSessionMeshWrite(receipts)
        );
        if (!result.ok) {
          return forbiddenResponse({
            code: SessionMeshForbiddenCode.FeedbackForbidden,
          });
        }
        return successResponse(
          withOperationReceipt({ event: result.value }, receipts)
        );
      } catch (error) {
        return errorResponse("Failed to record Session Mesh feedback", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
