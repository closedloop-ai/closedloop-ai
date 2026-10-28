import {
  OperationKind,
  OperationReceiptOutcome,
} from "@repo/api/src/types/attribution-evidence";
import { failure } from "@repo/api/src/types/common";
import {
  type MoveArtifactRequest,
  type MoveArtifactResponse,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import { Status } from "@repo/api/src/types/result";
import { NextResponse } from "next/server";
import { documentService } from "@/app/documents/document-service";
import { moveArtifactValidator } from "@/app/documents/validators";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { resolveDocumentId, resolveProjectId } from "@/lib/identifier-utils";
import {
  withOperationReceipt,
  withOperationReceipts,
} from "@/lib/operation-receipts/operation-receipt-recorder";
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
 * POST /projects/:id/artifacts/move
 *
 * Move a single root DOCUMENT artifact to a new position in its project's
 * stack rank (PRD-421). Backs drag-drop, keyboard ⌘↑/⌘↓, and the row-menu
 * Move-to-top / Move-to-bottom actions in the project page.
 *
 * Auth: `withAnyAuth` accepts both Clerk session and `sk_live_*` API keys so
 * MCP / agent clients can reorder programmatically (per PLN-755 OQ-2).
 *
 * Status mapping (per apps/api/AGENTS.md "Errors as values"):
 *  - 200 — move accepted
 *  - 400 — Zod validation failure OR ambiguous/invalid reference id
 *  - 404 — project not in caller's org, or artifact/reference id not in project
 *  - 409 — an `expectedOrder` precondition did not match the ordering the move
 *    transaction observed (ISS-8728); nothing was written
 *  - 500 — uncaught service error (treated as a true server fault)
 */
export const POST = withAnyAuth<
  MoveArtifactResponse,
  "/projects/[id]/artifacts/move"
>(
  withOperationReceipts(
    OperationKind.Move,
    async ({ user }, request, params, receipts) => {
      try {
        const { id: projectIdentifier } = await params;
        const resolvedProjectId = await resolveProjectId(
          projectIdentifier,
          user.organizationId
        );
        if (!resolvedProjectId) {
          return notFoundResponse("Project");
        }
        const project = await projectsService.findById(
          resolvedProjectId,
          user.organizationId
        );
        if (!project) {
          return notFoundResponse("Project");
        }

        const { body, errorResponse: parseError } = await parseBody(
          request,
          moveArtifactValidator
        );
        if (parseError) {
          return parseError;
        }

        // Resolve artifact / reference slugs (PRD-/PLN-/FEA-) to UUIDs so callers
        // (MCP agents, CLI) can move by the slugs they hold; UUIDs pass through.
        // The service still verifies project membership of the resolved ids.
        const artifactId = await resolveDocumentId(
          body.artifactId,
          user.organizationId
        );
        if (!artifactId) {
          return notFoundResponse("Artifact");
        }
        // ISS-8728: the optional precondition rides through untouched. It is already
        // UUIDs by the time the validator has accepted it, so there is nothing to
        // resolve — and a `{ ...body }` spread here instead would silently carry any
        // future field past the explicit shaping the two branches below rely on.
        const expectedOrder = body.expectedOrder;
        let resolvedBody: MoveArtifactRequest = {
          artifactId,
          position: body.position,
          ...(expectedOrder ? { expectedOrder } : {}),
        };
        if (
          body.position === MovePosition.Before ||
          body.position === MovePosition.After
        ) {
          const referenceArtifactId = await resolveDocumentId(
            body.referenceArtifactId,
            user.organizationId
          );
          if (!referenceArtifactId) {
            return notFoundResponse("Reference artifact");
          }
          resolvedBody = {
            artifactId,
            position: body.position,
            referenceArtifactId,
            ...(expectedOrder ? { expectedOrder } : {}),
          };
        }

        const result = await documentService.moveArtifact(
          project.id,
          user.organizationId,
          resolvedBody,
          // PRD-800 'No-op writes': a move to the slot the
          // artifact already holds changes nothing.
          receipts.whenRecording((tx, { positionChanged }) =>
            receipts.record(
              tx,
              positionChanged
                ? {
                    operationKind: OperationKind.Move,
                    outcome: OperationReceiptOutcome.Committed,
                    targetArtifactId: artifactId,
                    changedFields: ["sortOrder"],
                  }
                : {
                    operationKind: OperationKind.Move,
                    outcome: OperationReceiptOutcome.NoOp,
                    targetArtifactId: artifactId,
                  }
            )
          )
        );

        if (result.ok) {
          return successResponse(
            withOperationReceipt(
              { moved: true as const, ...result.value },
              receipts
            )
          );
        }
        if (result.error.status === Status.Conflict) {
          // ISS-8728: the caller sent an `expectedOrder` and the transaction saw a
          // different one, so the move was refused rather than applied over a
          // reorder that landed after the caller's read. Unlike the 404 below —
          // which bypasses its helper because `notFoundResponse` APPENDS
          // " not found" to its argument — `conflictResponse` leaves the message
          // untouched, so there is nothing to hand-roll around.
          return conflictResponse(result.error.message);
        }
        if (result.error.status === Status.NotFound) {
          // Bypass `notFoundResponse(entity)` because it appends " not found" to
          // its argument; the service-supplied message already contains that
          // phrase (e.g. "Artifact <id> not found in project <pid>"). Send the
          // raw service message instead so the wire body reads naturally.
          return NextResponse.json(failure(result.error.message), {
            status: 404,
          });
        }
        return badRequestResponse(result.error.message);
      } catch (error) {
        return errorResponse("Failed to move artifact", error);
      }
    }
  )
);
