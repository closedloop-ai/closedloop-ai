import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { registerAttachmentActionTool } from "./attachment-tool-utils.js";

/**
 * Register the delete-attachment tool on the given MCP server.
 * The API service enforces creator-only deletion for the authenticated user.
 */
export function registerDeleteAttachment(
  server: McpServer,
  apiClient: ApiClient
): void {
  registerAttachmentActionTool<{ deleted: true }>(server, apiClient, {
    description:
      "Delete one attachment from a document (PRD, implementation plan, feature, or template). Only attachments explicitly created by the authenticated user can be deleted. Pass the user's document slug verbatim for entityId.",
    method: "delete",
    toolName: "delete-attachment",
  });
}
