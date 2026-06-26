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
  badRequestResponse,
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
 * Status mapping (per apps/api/CLAUDE.md "Errors as values"):
 *  - 200 — move accepted
 *  - 400 — Zod validation failure OR ambiguous/invalid reference id
 *  - 404 — project not in caller's org, or artifact/reference id not in project
 *  - 500 — uncaught service error (treated as a true server fault)
 */
export const POST = withAnyAuth<
  MoveArtifactResponse,
  "/projects/[id]/artifacts/move"
>(async ({ user }, request, params) => {
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
    let resolvedBody: MoveArtifactRequest = {
      artifactId,
      position: body.position,
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
      };
    }

    const result = await documentService.moveArtifact(
      project.id,
      user.organizationId,
      resolvedBody
    );

    if (result.ok) {
      return successResponse({ moved: true as const, ...result.value });
    }
    if (result.error.status === Status.NotFound) {
      // Bypass `notFoundResponse(entity)` because it appends " not found" to
      // its argument; the service-supplied message already contains that
      // phrase (e.g. "Artifact <id> not found in project <pid>"). Send the
      // raw service message instead so the wire body reads naturally.
      return NextResponse.json(failure(result.error.message), { status: 404 });
    }
    return badRequestResponse(result.error.message);
  } catch (error) {
    return errorResponse("Failed to move artifact", error);
  }
});
