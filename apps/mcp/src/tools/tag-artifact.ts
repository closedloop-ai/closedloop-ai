import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TAG_NAME_MAX_LENGTH,
  TAG_NAME_RULE_MESSAGE,
  TagEntityType,
} from "@repo/api/src/types/tag.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  resolveArtifactId,
  resolveOrCreateTag,
  TAG_APPLY_SIDE_EFFECT_HELP,
  TAG_DOCUMENT_SCOPE_HELP,
  TAG_NAME_INPUT_HELP,
  TAGS_WRITABLE_HELP,
  type TagWireRow,
} from "./tag-resolution.js";
import { requiredIdOrSlug, withErrorHandling } from "./tool-utils.js";

/**
 * Register the tag-artifact tool.
 *
 * Resolution order is load-bearing: the document is resolved BEFORE any tag is
 * created, so a bad `documentId` cannot leave a new tag behind in the
 * organization's namespace.
 */
export function registerTagArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "tag-artifact",
    {
      description: `Apply a named tag to a document, creating the tag if the organization does not have one by that name yet. ${TAGS_WRITABLE_HELP} Matching is case-insensitive, so passing "dsp" reuses an existing "DSP" tag rather than making a second one. Re-applying a tag the document already has adds no second link, but it is not a no-op: the GitHub label reconciliation below still runs. ${TAG_APPLY_SIDE_EFFECT_HELP} ${TAG_DOCUMENT_SCOPE_HELP}`,
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
            `${TAG_NAME_INPUT_HELP} If no tag matches, one is created — and creating requires 1-${TAG_NAME_MAX_LENGTH} characters: ${TAG_NAME_RULE_MESSAGE}. A new name outside that rule is rejected by the API. The colour is chosen by the server.`
          ),
      },
    },
    ({ documentId, tagName }) =>
      withErrorHandling(async () => {
        const artifactId = await resolveArtifactId(apiClient, documentId);
        const { tag, created } = await resolveOrCreateTag(apiClient, tagName);

        try {
          await apiClient.post<ApplyTagResponse>("/entity-tags", {
            tagId: tag.id,
            entityType: TagEntityType.Artifact,
            entityId: artifactId,
          });
        } catch (error) {
          throw withCreatedTagContext(error, tag, created);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { applied: true, artifactId, tag, created },
                null,
                2
              ),
            },
          ],
        };
      })
  );
}

/** `POST /entity-tags` acknowledges the write without echoing the row. */
type ApplyTagResponse = { applied: boolean };

/**
 * When the apply fails after this call created the tag, say so.
 *
 * The tag row survives an apply failure and has consumed a palette slot, so an
 * agent told only "not found" would not know a tag now exists under that name.
 * A retry converges — the second pass finds it and reports `created: false`.
 */
function withCreatedTagContext(
  error: unknown,
  tag: TagWireRow,
  created: boolean
): unknown {
  if (!created) {
    return error;
  }
  const reason = error instanceof Error ? error.message : "Unknown error";
  const options =
    error instanceof McpApiError
      ? { code: error.code, status: error.status, timestamp: error.timestamp }
      : {};
  return new McpApiError(
    `${reason} — note: tag "${tag.name}" was created by this call and still exists, so retrying will reuse it rather than making another.`,
    options
  );
}
