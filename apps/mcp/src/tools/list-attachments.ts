import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EntityType } from "@repo/api/src/types/entity-link.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

const ATTACHMENT_ENTITY_TYPE_OPTIONS = [
  EntityType.Document,
  EntityType.Feature,
] as [string, ...string[]];

/**
 * Register the list-attachments tool on the given MCP server.
 * Calls GET /documents/:entityId/attachments or /features/:entityId/attachments
 * based on the entityType parameter.
 */
export function registerListAttachments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-attachments",
    {
      description:
        "List file attachments for a document or feature. Returns attachment metadata including id, filename, mimeType, and sizeBytes.",
      inputSchema: {
        entityType: z
          .enum(ATTACHMENT_ENTITY_TYPE_OPTIONS)
          .describe("Entity type: DOCUMENT or FEATURE"),
        entityId: z.string().describe("Document or feature ID"),
      },
    },
    ({ entityType, entityId }) =>
      withErrorHandling(async () => {
        const basePath =
          entityType === EntityType.Feature ? "features" : "documents";
        const path = `/${basePath}/${encodePathSegment(entityId)}/attachments`;
        const attachments = await apiClient.get<unknown>(path);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(attachments, null, 2),
            },
          ],
        };
      })
  );
}
