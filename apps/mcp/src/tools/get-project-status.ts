import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

/**
 * Register the get-project-status tool on the given MCP server.
 * Backward-compatible alias for get-project.
 * Calls GET /projects/:projectId and returns the same payload as get-project.
 */
export function registerGetProjectStatus(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "get-project-status",
    "Deprecated alias of get-project. Returns project details.",
    {
      projectId: z.string().describe("ID of the project to retrieve"),
    },
    ({ projectId }) =>
      withErrorHandling(async () => {
        const project = await apiClient.get<unknown>(
          `/projects/${encodePathSegment(projectId)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(project, null, 2),
            },
          ],
        };
      })
  );
}
