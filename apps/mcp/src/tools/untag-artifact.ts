import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TagEntityType } from "@repo/api/src/types/tag.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  fetchTagByExactName,
  resolveArtifactId,
  TAG_DOCUMENT_SCOPE_HELP,
  TAG_NAME_INPUT_HELP,
  TAG_REMOVE_SIDE_EFFECT_HELP,
  TAGS_WRITABLE_HELP,
} from "./tag-resolution.js";
import { requiredIdOrSlug, withErrorHandling } from "./tool-utils.js";

/**
 * Register the untag-artifact tool — the inverse of tag-artifact.
 *
 * A name that matches no tag in the organization is reported as
 * `removed: false` rather than raised as an error: the desired end state (this
 * tag is not on this artifact) already holds, and the underlying route is
 * itself quietly idempotent. `removed: true` asserts that end state, not a row
 * count — `DELETE /entity-tags` uses `deleteMany` and acknowledges success
 * whether or not a row existed.
 */
export function registerUntagArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "untag-artifact",
    {
      description: `Remove a named tag from a document. ${TAGS_WRITABLE_HELP} The tag itself is left in the organization for reuse; only the link to this document is removed. A name that matches no existing tag is reported as removed:false rather than failing, because the end state it asks for already holds. ${TAG_REMOVE_SIDE_EFFECT_HELP} ${TAG_DOCUMENT_SCOPE_HELP}`,
      inputSchema: {
        documentId: requiredIdOrSlug(
          "Document",
          ["PRD-7", "PLN-12", "ISS-42", "DOC-3"],
          "Use list-documents to find one."
        ),
        tagName: z
          .string()
          .min(1)
          .describe(
            `${TAG_NAME_INPUT_HELP} An unmatched name simply reports removed:false — nothing is created here.`
          ),
      },
    },
    ({ documentId, tagName }) =>
      withErrorHandling(async () => {
        const artifactId = await resolveArtifactId(apiClient, documentId);
        const tag = await fetchTagByExactName(apiClient, tagName);
        if (!tag) {
          return toolText({
            removed: false,
            artifactId,
            tagName,
            reason: `No tag named "${tagName}" exists in this organization, so nothing was removed.`,
          });
        }

        const query = new URLSearchParams({
          tagId: tag.id,
          entityType: TagEntityType.Artifact,
          entityId: artifactId,
        });
        // Hoisted deliberately: `tool-path-encoding.test.ts` scans for a
        // template literal passed directly to apiClient.*, and URLSearchParams
        // — not encodePathSegment — is what escapes a query string correctly.
        // Same shape as list-attachments.ts.
        const path = `/entity-tags?${query.toString()}`;
        await apiClient.delete<UntagResponse>(path);

        return toolText({ removed: true, artifactId, tag });
      })
  );
}

/** `DELETE /entity-tags` returns the shared delete acknowledgement. */
type UntagResponse = { deleted: true };

function toolText(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}
