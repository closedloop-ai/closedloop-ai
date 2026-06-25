import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type MoveArtifactRequest,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  asRecord,
  describeIdOrSlug,
  encodePathSegment,
  readNumber,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Build the move request body, enforcing the position/reference pairing the
 * API expects: `before` / `after` require a reference artifact; `top` /
 * `bottom` must not carry one. Artifact identifiers pass through as-is —
 * slug-or-UUID resolution is the move endpoint's responsibility.
 */
function buildMoveRequest(input: {
  artifactId: string;
  position: MovePosition;
  referenceArtifactId?: string;
}): MoveArtifactRequest {
  const { artifactId, position, referenceArtifactId } = input;
  const needsReference =
    position === MovePosition.Before || position === MovePosition.After;

  if (needsReference && referenceArtifactId === undefined) {
    throw new McpApiError(
      `position '${position}' requires referenceArtifactId`,
      { status: 400 }
    );
  }
  if (!needsReference && referenceArtifactId !== undefined) {
    throw new McpApiError(
      "referenceArtifactId is only valid with position 'before' or 'after'",
      { status: 400 }
    );
  }

  if (referenceArtifactId === undefined) {
    return { artifactId, position };
  }
  return { artifactId, position, referenceArtifactId };
}

/**
 * Register the move-artifact tool: reorder a root artifact within its
 * project's stack rank (PRD-421 / PLN-755). Calls
 * `POST /projects/:id/artifacts/move`. Requires write scope.
 */
export function registerMoveArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "move-artifact",
    {
      description:
        "Reorder a root artifact within its project's stack rank (the human-curated priority order on the project page). Requires write scope.\n\nStack rank is a project-wide, root-level ordering: only top-level documents/features participate, not nested children. Use `top` / `bottom` to move to the ends, or `before` / `after` with `referenceArtifactId` to position relative to another artifact. Read `sortOrder` from list-documents / get-document to see the current order (lower sorts first).",
      inputSchema: {
        projectId: z.string().describe(describeIdOrSlug("Project", "PRO-7")),
        artifactId: z
          .string()
          .describe(
            `${describeIdOrSlug("Artifact", ["PRD-7", "PLN-12", "FEA-42"])} The artifact to move.`
          ),
        position: z
          .enum(MovePosition)
          .describe(
            "Where to move the artifact: 'top' / 'bottom' of the project, or 'before' / 'after' the referenceArtifactId."
          ),
        referenceArtifactId: z
          .string()
          .optional()
          .describe(
            `${describeIdOrSlug("Artifact", ["PRD-7", "PLN-12", "FEA-42"])} Required for 'before' / 'after'; omit for 'top' / 'bottom'.`
          ),
      },
    },
    ({ projectId, artifactId, position, referenceArtifactId }) =>
      withErrorHandling(async () => {
        const body = buildMoveRequest({
          artifactId,
          position,
          referenceArtifactId,
        });
        const response = await apiClient.post<unknown>(
          `/projects/${encodePathSegment(projectId)}/artifacts/move`,
          body
        );
        const row = asRecord(response);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  moved: true,
                  artifactId: body.artifactId,
                  position: body.position,
                  referenceArtifactId: body.referenceArtifactId ?? null,
                  newSortOrder: readNumber(row.newSortOrder),
                },
                null,
                2
              ),
            },
          ],
        };
      })
  );
}
