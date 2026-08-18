import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

/**
 * The inverse of `create-artifact-link`.
 *
 * Identified by the link's own `id` rather than the `(sourceId, targetId,
 * linkType)` triple: the id round-trips from `list-artifact-links`, and naming
 * the exact edge keeps a destructive operation from matching more than the
 * caller meant. `DELETE /artifact-links/{id}` deletes by `deleteMany`, so a
 * link that is already gone reports success rather than erroring — retries and
 * concurrent cleanups are safe.
 */
export function registerDeleteArtifactLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "delete-artifact-link",
    {
      description:
        "Remove one typed relationship between artifacts — the inverse of create-artifact-link. Pass the link's own `id` (from list-artifact-links or the create-artifact-link response), NOT the artifact ids or slugs. No link type is a no-op: removing a PRODUCES link changes lineage, re-shaping the project tree and the loop roll-ups that derive from it, so a child detached from its parent stops appearing under it; removing a BLOCKS link can release deferred loop work, because an artifact is clear to dispatch once no non-terminal source blocks it — that release happens on the next reconciliation pass, not at delete time; removing a RELATES_TO link to an evergreen Document drops that document from the artifact's later loop context packs. Check what a link is doing before removing it. Deleting a link that is already gone succeeds quietly, so retries are safe. To re-parent an artifact, create the new PRODUCES link first and delete the stale one second, so the child is never left without a parent.",
      inputSchema: {
        linkId: z
          .uuid()
          .describe(
            "Artifact link UUID — the `id` field of a link returned by list-artifact-links or create-artifact-link. This identifies the relationship itself, not either artifact it connects."
          ),
      },
    },
    ({ linkId }) =>
      withErrorHandling(async () => {
        const result = await apiClient.delete<DeleteArtifactLinkResponse>(
          `/artifact-links/${encodePathSegment(linkId)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      })
  );
}

/** `DELETE /artifact-links/{id}` returns the shared delete acknowledgement. */
type DeleteArtifactLinkResponse = { deleted: true };
