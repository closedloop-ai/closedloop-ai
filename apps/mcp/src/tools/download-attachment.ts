import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { registerAttachmentActionTool } from "./attachment-tool-utils.js";

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
  registerAttachmentActionTool<{ downloadUrl: string }>(server, apiClient, {
    description:
      "Get a presigned download URL for a file attachment on a document (PRD, implementation plan, feature, or template). The URL expires quickly — download the file immediately after calling this tool. Pass the user's document slug verbatim for entityId.",
    entityIdDescriptionSuffix:
      "Required for org-scoped verification (prevents cross-org access).",
    method: "get",
    toolName: "download-attachment",
  });
}
