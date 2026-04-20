import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the download-attachment tool on the given MCP server.
 * Calls GET /documents/:entityId/attachments/:attachmentId. Features are
 * documents (type=FEATURE), so feature IDs/slugs resolve through the same
 * endpoint. Returns a presigned download URL — use it immediately as it
 * expires quickly.
 */
export function registerDownloadAttachment(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "download-attachment",
    {
      description:
        "Get a presigned download URL for a file attachment on a document (PRD, implementation plan, feature, or template). The URL expires quickly — download the file immediately after calling this tool. Pass the user's document slug verbatim for entityId.",
      inputSchema: {
        entityId: z
          .string()
          .describe(
            `${describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])} Required for org-scoped verification (prevents cross-org access).`
          ),
        attachmentId: z.string().describe("Attachment UUID"),
      },
    },
    ({ entityId, attachmentId }) =>
      withErrorHandling(async () => {
        const path = `/documents/${encodePathSegment(entityId)}/attachments/${encodePathSegment(attachmentId)}`;
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
