import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  type ProjectHierarchyRevision,
  type ProjectHierarchyTransactionResponse,
  projectHierarchyTransactionSchema,
} from "@repo/api/src/types/project-hierarchy-transaction";
import { Status } from "@repo/api/src/types/result";
import {
  hierarchyPlacementWrite,
  recordPlacementReceipts,
} from "@/app/projects/project-artifact-order-receipts";
import { projectHierarchyCompatibilityService } from "@/app/projects/project-hierarchy-compatibility-service";
import { artifactTagPermissionsForAuth } from "@/app/tags/artifact-tag-projection";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

/** Read the ungated hierarchy revision used by the flag-off transaction. */
export const GET = withAnyAuth<
  ProjectHierarchyRevision,
  "/projects/[id]/artifacts/hierarchy-transactions"
>(async (auth, _request, params) => {
  try {
    const projectId = await resolveProjectId(
      (await params).id,
      auth.user.organizationId
    );
    const revision = projectId
      ? await projectHierarchyCompatibilityService.getRevision(
          projectId,
          auth.user.organizationId,
          {
            userId: auth.user.id,
            authMethod: auth.authMethod,
            apiKeyId: auth.apiKeyId,
            desktopSessionId: auth.desktopSessionId,
          }
        )
      : null;
    return revision ? successResponse(revision) : notFoundResponse("Project");
  } catch (error) {
    return errorResponse("Failed to read project hierarchy", error);
  }
});

/** Preserve flag-off selected-set writes without widening the manual placement route. */
export const POST = withAnyAuth<
  ProjectHierarchyTransactionResponse,
  "/projects/[id]/artifacts/hierarchy-transactions"
>(
  withOperationReceipts(
    OperationKind.Move,
    async (auth, request, params, receipts) => {
      try {
        const projectId = await resolveProjectId(
          (await params).id,
          auth.user.organizationId
        );
        if (!projectId) {
          return notFoundResponse("Project");
        }
        const { body, errorResponse: parseError } = await parseBody(
          request,
          projectHierarchyTransactionSchema
        );
        if (parseError) {
          return parseError;
        }
        // ISS-12552: one receipt per moved artifact, so the batch response
        // carries none of its own.
        const result = await projectHierarchyCompatibilityService.transact(
          projectId,
          auth.user.organizationId,
          {
            userId: auth.user.id,
            authMethod: auth.authMethod,
            apiKeyId: auth.apiKeyId,
            desktopSessionId: auth.desktopSessionId,
            tagPermissions: artifactTagPermissionsForAuth(auth),
          },
          body,
          receipts.whenRecording((tx, placed) =>
            recordPlacementReceipts(
              tx,
              receipts,
              hierarchyPlacementWrite(placed, body)
            )
          )
        );
        if (result.ok) {
          return successResponse(result.value);
        }
        if (result.error.status === Status.Forbidden) {
          return forbiddenResponse();
        }
        if (result.error.status === Status.Conflict) {
          return conflictResponse(result.error.message);
        }
        if (result.error.status === Status.NotFound) {
          return notFoundResponse("Project hierarchy");
        }
        return badRequestResponse(result.error.message);
      } catch (error) {
        return errorResponse("Failed to update project hierarchy", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);
