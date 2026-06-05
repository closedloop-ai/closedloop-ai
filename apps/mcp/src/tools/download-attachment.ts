import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EntityType } from "@repo/api/src/types/entity-link.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

const ATTACHMENT_ENTITY_TYPE_OPTIONS = [
  EntityType.Artifact,
  EntityType.Feature,
] as [string, ...string[]];

/**
 * Register the download-attachment tool on the given MCP server.
 * Calls GET /artifacts/:entityId/attachments/:attachmentId or
 * /features/:entityId/attachments/:attachmentId based on the entityType parameter.
 * Returns a presigned download URL — use it immediately as it expires quickly.
 */
export function registerDownloadAttachment(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "download-attachment",
    {
      description:
        "Get a presigned download URL for a file attachment. The URL expires quickly — download the file immediately after calling this tool.",
      inputSchema: {
        entityType: z
          .enum(ATTACHMENT_ENTITY_TYPE_OPTIONS)
          .describe("Entity type: ARTIFACT or FEATURE"),
        entityId: z
          .string()
          .describe(
            "Artifact or feature ID (required for org-scoped verification — prevents cross-org access)"
          ),
        attachmentId: z.string(),
      },
    },
    ({ entityType, entityId, attachmentId }) =>
      withErrorHandling(async () => {
        const basePath =
          entityType === EntityType.Feature ? "features" : "artifacts";
        const path = `/${basePath}/${encodePathSegment(entityId)}/attachments/${encodePathSegment(attachmentId)}`;
        const result = await apiClient.get<{ downloadUrl: string }>(path);
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
