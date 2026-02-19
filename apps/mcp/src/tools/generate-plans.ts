import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";

/**
 * Register the generate-plans tool on the given MCP server.
 * Calls POST /projects/:projectId/generate-plans to trigger plan generation.
 */
export function registerGeneratePlans(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "generate-plans",
    "Trigger AI plan generation for a project",
    {
      projectId: z.string().describe("ID of the project to generate plans for"),
    },
    async ({ projectId }) => {
      const result = await apiClient.post<unknown>(
        `/projects/${projectId}/generate-plans`,
        {}
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
