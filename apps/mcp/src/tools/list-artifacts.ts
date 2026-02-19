import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";

/**
 * Register the list-artifacts tool on the given MCP server.
 * Calls GET /artifacts with optional query filters for projectId, type, and status.
 */
export function registerListArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-artifacts",
    "List artifacts with optional filters by projectId, type, and status",
    {
      projectId: z.string().optional().describe("Filter by project ID"),
      type: z.string().optional().describe("Filter by artifact type"),
      status: z.string().optional().describe("Filter by artifact status"),
    },
    async ({ projectId, type, status }) => {
      const query: Record<string, string> = {};
      if (projectId !== undefined) {
        query.projectId = projectId;
      }
      if (type !== undefined) {
        query.type = type;
      }
      if (status !== undefined) {
        query.status = status;
      }

      const artifacts = await apiClient.get<unknown[]>("/artifacts", query);
      const text =
        artifacts.length === 0
          ? "No artifacts found."
          : JSON.stringify(artifacts, null, 2);
      return {
        content: [{ type: "text" as const, text }],
      };
    }
  );
}
