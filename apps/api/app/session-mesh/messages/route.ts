import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  SessionMeshForbiddenCode,
  sessionMeshPublishValidator,
} from "@repo/api/src/types/session-mesh";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
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
          sessionMeshPublishValidator
        );
        if (parseError) {
          return parseError;
        }
        const result = await sessionMeshService.publish(
          {
            organizationId: user.organizationId,
            userId: user.id,
            message: body,
          },
          recordSessionMeshWrite(receipts)
        );
        if (!result.ok) {
          return forbiddenResponse({
            code: SessionMeshForbiddenCode.PublishForbidden,
          });
        }
        return successResponse(withOperationReceipt(result.value, receipts));
      } catch (error) {
        return errorResponse("Failed to publish Session Mesh message", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

export const GET = withSessionMeshAuth(async ({ user }, request) => {
  try {
    const agentId = request.nextUrl.searchParams.get("agentId")?.trim();
    const messageId = request.nextUrl.searchParams.get("messageId")?.trim();
    if (!(agentId && messageId)) {
      return badRequestResponse("agentId and messageId are required");
    }
    const delivery = await sessionMeshService.messageForRecipient({
      organizationId: user.organizationId,
      userId: user.id,
      agentId,
      messageId,
    });
    if (!delivery) {
      return notFoundResponse("Session Mesh message");
    }
    return successResponse({ message: delivery.message, delivery });
  } catch (error) {
    return errorResponse("Failed to fetch Session Mesh message", error);
  }
});
