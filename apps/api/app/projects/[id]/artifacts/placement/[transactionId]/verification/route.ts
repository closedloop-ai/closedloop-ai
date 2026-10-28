import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import type { ProjectArtifactPlacementVerificationResponse } from "@repo/api/src/types/project-artifact-placement";
import { recoverProjectArtifactPlacementValidator } from "@repo/api/src/types/project-artifact-placement";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { projectArtifactPlacementVerificationService } from "@/app/documents/project-artifact-placement-verification-service";
import { recordPlacementReceipts } from "@/app/projects/project-artifact-order-receipts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import type { AuthContext } from "@/lib/auth/with-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import { isManualArtifactOrderingEnabled } from "@/lib/manual-artifact-ordering-feature";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";

type VerificationRoute =
  "/projects/[id]/artifacts/placement/[transactionId]/verification";

/** Verify a placement receipt against the current canonical hierarchy. */
export const GET = withAnyAuth<
  ProjectArtifactPlacementVerificationResponse,
  VerificationRoute
>(async (auth, _request, params) => {
  try {
    if (!(await isManualArtifactOrderingEnabled(auth))) {
      return notFoundResponse("Artifact placement receipt");
    }
    const { id, transactionId } = await params;
    const resolved = await resolveParams(auth, { id, transactionId });
    if (!resolved) {
      return notFoundResponse("Artifact placement receipt");
    }
    return placementResultResponse(
      await projectArtifactPlacementVerificationService.verifyProjectArtifactPlacement(
        { ...resolved, actor: placementActor(auth) }
      )
    );
  } catch (error) {
    return errorResponse("Failed to verify artifact placement", error);
  }
});

/** Restore a drifted hierarchy to the placement receipt's durable after-state. */
export const POST = withAnyAuth<
  ProjectArtifactPlacementVerificationResponse,
  VerificationRoute
>(
  withOperationReceipts(
    OperationKind.Move,
    async (auth, request, params, receipts) => {
      try {
        if (!(await isManualArtifactOrderingEnabled(auth))) {
          return notFoundResponse("Artifact placement receipt");
        }
        const { id, transactionId } = await params;
        const resolved = await resolveParams(auth, { id, transactionId });
        if (!resolved) {
          return notFoundResponse("Artifact placement receipt");
        }
        const { body, errorResponse: parseError } = await parseBody(
          request,
          recoverProjectArtifactPlacementValidator
        );
        if (parseError) {
          return parseError;
        }
        // ISS-12552: one receipt per restored artifact, so the response
        // carries none of its own.
        return placementResultResponse(
          await projectArtifactPlacementVerificationService.recoverProjectArtifactPlacement(
            {
              ...resolved,
              actor: placementActor(auth),
              expectedProjectVersions: body.expectedProjectVersions,
            },
            receipts.whenRecording((tx, written) =>
              recordPlacementReceipts(tx, receipts, written)
            )
          )
        );
      } catch (error) {
        return errorResponse("Failed to recover artifact placement", error);
      }
    }
  ),
  { requiredScopes: ["write"] }
);

async function resolveParams(
  auth: AuthContext,
  params: { id: string; transactionId: string }
) {
  const routeProjectId = await resolveProjectId(
    params.id,
    auth.user.organizationId
  );
  return routeProjectId
    ? {
        routeProjectId,
        organizationId: auth.user.organizationId,
        transactionId: params.transactionId,
      }
    : null;
}

function placementActor(auth: AuthContext) {
  return {
    userId: auth.user.id,
    authMethod: auth.authMethod,
    apiKeyId: auth.apiKeyId,
    desktopSessionId: auth.desktopSessionId,
  };
}

function placementResultResponse(
  result: Awaited<
    ReturnType<
      typeof projectArtifactPlacementVerificationService.verifyProjectArtifactPlacement
    >
  >
) {
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
    return notFoundResponse("Artifact placement receipt");
  }
  return badRequestResponse(result.error.message, {
    code: result.error.detail.reason,
  });
}
