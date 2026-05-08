import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the list-attachments tool on the given MCP server.
 * Calls GET /documents/:entityId/attachments. Features are documents
 * (type=FEATURE), so feature IDs/slugs resolve through the same endpoint.
 */
export function registerListAttachments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-attachments",
    {
      description:
        "List file attachments for a document (PRD, implementation plan, feature, or template) by UUID or slug. Returns attachment metadata including id, filename, mimeType, and sizeBytes. Pass the user's slug verbatim.",
      inputSchema: {
        entityId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
      },
    },
    ({ entityId }) =>
      withErrorHandling(async () => {
        const path = `/documents/${encodePathSegment(entityId)}/attachments`;
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
