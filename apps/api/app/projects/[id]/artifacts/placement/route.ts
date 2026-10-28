import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import type {
  ProjectArtifactPlacementResponse,
  ProjectArtifactPlacementStateResponse,
} from "@repo/api/src/types/project-artifact-placement";
import { projectArtifactPlacementValidator } from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { placeProjectArtifactsWithLanePatch } from "@/app/artifacts/project-artifact-board-placement";
import { projectArtifactPlacementService } from "@/app/documents/project-artifact-placement-service";
import {
  placementWrite,
  recordPlacementReceipts,
} from "@/app/projects/project-artifact-order-receipts";
import { artifactTagPermissionsForAuth } from "@/app/tags/artifact-tag-projection";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type { AuthContext } from "@/lib/auth/with-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import { withProjectArtifactPlacementGate } from "@/lib/manual-artifact-ordering-feature";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

/** Return the opaque project hierarchy version used by placement preconditions. */
export const GET = withAnyAuth<
  ProjectArtifactPlacementStateResponse,
  "/projects/[id]/artifacts/placement"
>(async (auth, _request, params) =>
  withProjectArtifactPlacementGate(
    auth,
    async () => {
      try {
        const { user } = auth;
        const projectId = await resolveOrgProjectId(
          (await params).id,
          user.organizationId
        );
        if (!projectId) {
          return notFoundResponse("Project");
        }
        const state =
          await projectArtifactPlacementService.getProjectPlacementState(
            projectId,
            user.organizationId,
            placementActor(auth)
          );
        if (!state) {
          return notFoundResponse("Project");
        }
        return successResponse({
          projectId,
          projectVersion: state.projectVersion,
          canPlaceArtifacts: state.canPlaceArtifacts,
        });
      } catch (error) {
        return errorResponse("Failed to read artifact placement state", error);
      }
    },
    () => notFoundResponse("Artifact placement")
  )
);

/** Atomically place one or many complete artifact subtrees, or undo a receipt. */
export const POST = withAnyAuth<
  ProjectArtifactPlacementResponse,
  "/projects/[id]/artifacts/placement"
>(
  withOperationReceipts(
    OperationKind.Move,
    async (auth, request, params, receipts) =>
      withProjectArtifactPlacementGate(
        auth,
        async () => {
          try {
            const { user } = auth;
            const projectId = await resolveOrgProjectId(
              (await params).id,
              user.organizationId
            );
            if (!projectId) {
              return notFoundResponse("Project");
            }
            const { body, errorResponse: parseError } = await parseBody(
              request,
              projectArtifactPlacementValidator
            );
            if (parseError) {
              return parseError;
            }
            // ISS-12552: one receipt per moved artifact, so the batch response
            // carries none of its own.
            const result = await placeProjectArtifactsWithLanePatch(
              projectId,
              user.organizationId,
              body,
              placementActor(auth),
              {
                recordPlaced: receipts.whenRecording((tx, placed) =>
                  recordPlacementReceipts(
                    tx,
                    receipts,
                    placementWrite(placed, body)
                  )
                ),
              }
            );
            if (result.ok) {
              return successResponse(result.value);
            }
            if (result.error.status === Status.Conflict) {
              return NextResponse.json(
                conflictBody(result.error.message, result.error.detail),
                { status: Status.Conflict }
              ) as NextResponse<ApiResult<never>>;
            }
            if (result.error.status === Status.NotFound) {
              return notFoundResponse("Artifact or project");
            }
            return badRequestResponse(result.error.message, {
              code: result.error.detail.reason,
            });
          } catch (error) {
            return errorResponse("Failed to place artifacts", error);
          }
        },
        () => notFoundResponse("Artifact placement")
      )
  ),
  { requiredScopes: ["write"] }
);

function placementActor(auth: AuthContext) {
  return {
    userId: auth.user.id,
    authMethod: auth.authMethod,
    apiKeyId: auth.apiKeyId,
    desktopSessionId: auth.desktopSessionId,
    tagPermissions: artifactTagPermissionsForAuth(auth),
  };
}

async function resolveOrgProjectId(
  identifier: string,
  organizationId: string
): Promise<string | null> {
  const resolved = await resolveProjectId(identifier, organizationId);
  return resolved ?? null;
}
