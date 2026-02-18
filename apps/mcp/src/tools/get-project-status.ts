import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";

/**
 * Register the get-project-status tool on the given MCP server.
 * Calls GET /projects/:projectId and returns project details including artifact counts by status.
 */
export function registerGetProjectStatus(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "get-project-status",
    "Get detailed status of a project including artifact counts by status",
    {
      projectId: z.string().describe("ID of the project to retrieve"),
    },
    async ({ projectId }) => {
      const project = await apiClient.get<unknown>(`/projects/${projectId}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(project, null, 2),
          },
        ],
      };
    }
  );
}
