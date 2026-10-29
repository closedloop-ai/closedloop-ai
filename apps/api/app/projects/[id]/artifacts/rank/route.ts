import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import type { ApiResult } from "@repo/api/src/types/common";
import { conflictBody } from "@repo/api/src/types/common";
import {
  type BulkRankArtifactsResponse,
  bulkRankArtifactsValidator,
  type ProjectRankStateResponse,
} from "@repo/api/src/types/project-artifact-bulk-rank";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { artifactBulkRankService } from "@/app/documents/artifact-bulk-rank-service";
import { recordBulkRankReceipts } from "@/app/projects/project-artifact-order-receipts";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveProjectId } from "@/lib/identifier-utils";
import { withOperationReceipts } from "@/lib/operation-receipts/operation-receipt-recorder";
import {
  badRequestResponse,
  conflictResponse,
  errorResponse,
  notFoundResponse,
  parseBody,
  successResponse,
} from "@/lib/route-utils";
import { projectsService } from "../../../service";

/**
 * GET /projects/:id/artifacts/rank
 *
 * The project's current root stack rank: the ordered root artifact ids and the
 * `rankEpoch` they were read at. Both halves come from one snapshot, so the
 * epoch a caller sends back to POST describes exactly the order it saw
 * (ISS-8999).
 *
 * Status mapping:
 *  - 200 — rank state
 *  - 404 — project not in caller's org
 *  - 500 — uncaught service error
 */
export const GET = withAnyAuth<
  ProjectRankStateResponse,
  "/projects/[id]/artifacts/rank"
>(async ({ user }, _request, params) => {
  try {
    const { id: projectIdentifier } = await params;
    const projectId = await resolveOrgProjectId(
      projectIdentifier,
      user.organizationId
    );
    if (!projectId) {
      return notFoundResponse("Project");
    }

    const state = await artifactBulkRankService.getRankState(
      projectId,
      user.organizationId
    );
    return successResponse({
      rankEpoch: state.rankEpoch,
      orderedArtifactIds: state.orderedRootIds,
    });
  } catch (error) {
    return errorResponse("Failed to read project rank state", error);
  }
});

/**
 * POST /projects/:id/artifacts/rank
 *
 * Apply the COMPLETE desired order of a project's root DOCUMENT artifacts in
 * one transaction (ISS-8999). Either every rank moves or none does; there is no
 * partial-order window and no per-root round trip.
 *
 * Auth: `withAnyAuth`, matching the single-move route, so the offline stack
 * ranker can apply an order with an `sk_live_*` key.
 *
 * Status mapping (per apps/api/AGENTS.md "Errors as values"):
 *  - 200 — order committed, or replayed for an already-used idempotency key
 *  - 400 — Zod validation failure (unknown key, duplicate id, over the cap)
 *  - 404 — project not in caller's org
 *  - 409 — the root population or the epoch moved since the caller read it; the
 *          body carries the added / removed / reparented ids so the caller can
 *          re-read and retry rather than guess
 *  - 500 — uncaught service error
 */
export const POST = withAnyAuth<
  BulkRankArtifactsResponse,
  "/projects/[id]/artifacts/rank"
>(
  withOperationReceipts(
    OperationKind.Move,
    async ({ user }, request, params, receipts) => {
      try {
        const { id: projectIdentifier } = await params;
        const projectId = await resolveOrgProjectId(
          projectIdentifier,
          user.organizationId
        );
        if (!projectId) {
          return notFoundResponse("Project");
        }

        const { body, errorResponse: parseError } = await parseBody(
          request,
          bulkRankArtifactsValidator
        );
        if (parseError) {
          return parseError;
        }

        // ISS-12552: one receipt per ranked root, so the batch response
        // carries none of its own.
        const result = await artifactBulkRankService.bulkRankArtifacts(
          projectId,
          user.organizationId,
          body,
          user.id,
          receipts.whenRecording((tx, written) =>
            recordBulkRankReceipts(tx, receipts, written)
          )
        );

        if (result.ok) {
          return successResponse({ ranked: true as const, ...result.value });
        }
        if (result.error.status === Status.Conflict) {
          const detail = result.error.conflict;
          if (!detail) {
            return conflictResponse(result.error.message);
          }
          // The typed 409 body carries `data` alongside the failure envelope,
          // so the caller reads the breakdown instead of parsing the message
          // string.
          return NextResponse.json(conflictBody(result.error.message, detail), {
            status: Status.Conflict,
          }) as NextResponse<ApiResult<never>>;
        }
        return badRequestResponse(result.error.message);
      } catch (error) {
        return errorResponse("Failed to apply bulk artifact rank", error);
      }
    }
  )
);

/**
 * Resolve a project slug or UUID to an id that is proven to belong to
 * `organizationId`. Returns null when either step fails, so both handlers give
 * the same 404 for a project in another organization as for one that does not
 * exist.
 */
async function resolveOrgProjectId(
  projectIdentifier: string,
  organizationId: string
): Promise<string | null> {
  const resolvedProjectId = await resolveProjectId(
    projectIdentifier,
    organizationId
  );
  if (!resolvedProjectId) {
    return null;
  }
  const project = await projectsService.findById(
    resolvedProjectId,
    organizationId
  );
  return project ? project.id : null;
}
