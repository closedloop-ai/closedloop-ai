import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  SessionMeshForbiddenCode,
  sessionMeshPresenceValidator,
  sessionMeshUnregisterValidator,
} from "@repo/api/src/types/session-mesh";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  forbiddenResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { withSessionMeshAuth } from "../auth";
import { recordSessionMeshWrite } from "../mesh-write-receipt";
import { sessionMeshService } from "../service";

export const GET = withSessionMeshAuth(async ({ user }, request) => {
  try {
    const repository = request.nextUrl.searchParams.get("repository")?.trim();
    const revision = request.nextUrl.searchParams.get("revision")?.trim();
    const cursor = request.nextUrl.searchParams.get("cursor")?.trim();
    if (cursor && cursor.length > 500) {
      return badRequestResponse("Invalid roster cursor");
    }
    return successResponse(
      await sessionMeshService.rosterPage(
        user.organizationId,
        { repository, revision },
        cursor
      )
    );
  } catch (error) {
    return errorResponse("Failed to read Session Mesh presence", error);
  }
});
export const POST = withSessionMeshAuth(
  withOperationReceipts(
    OperationKind.SessionMeshWrite,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          sessionMeshPresenceValidator
        );
        if (parseError) {
          return parseError;
        }
        const result = await sessionMeshService.upsertPresence(
          {
            organizationId: user.organizationId,
            userId: user.id,
            presence: body,
          },
          recordSessionMeshWrite(receipts)
        );
        if (!result.ok) {
          return forbiddenResponse({
            code: SessionMeshForbiddenCode.AgentForbidden,
          });
        }
        return successResponse(
          withOperationReceipt({ presence: result.value }, receipts)
        );
      } catch (error) {
        return errorResponse("Failed to update Session Mesh presence", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
export const DELETE = withSessionMeshAuth(
  withOperationReceipts(
    OperationKind.SessionMeshWrite,
    async ({ user }, request, _params, receipts) => {
      try {
        const { body, errorResponse: parseError } = await parseBody(
          request,
          sessionMeshUnregisterValidator
        );
        if (parseError) {
          return parseError;
        }
        const result = await sessionMeshService.unregisterPresence(
          {
            organizationId: user.organizationId,
            userId: user.id,
            agentId: body.agentId,
          },
          recordSessionMeshWrite(receipts)
        );
        return successResponse(
          withOperationReceipt({ removed: result.count }, receipts)
        );
      } catch (error) {
        return errorResponse(
          "Failed to unregister Session Mesh presence",
          error
        );
      }
    }
  ),
  { requiredScopes: ["write"] }
);
