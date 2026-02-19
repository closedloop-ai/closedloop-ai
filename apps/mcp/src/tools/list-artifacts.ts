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
    "List artifacts with optional filters by projectId and type",
    {
      projectId: z.string().optional().describe("Filter by project ID"),
      type: z
        .enum(["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE"])
        .optional()
        .describe("Filter by artifact type"),
    },
    async ({ projectId, type }) => {
      const query: Record<string, string> = {};
      if (projectId !== undefined) {
        query.projectId = projectId;
      }
      if (type !== undefined) {
        query.type = type;
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
