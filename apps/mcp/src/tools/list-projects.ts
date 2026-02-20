import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

/**
 * Register the list-projects tool on the given MCP server.
 * Calls GET /projects and returns a formatted project list.
 */
export function registerListProjects(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-projects",
    "List all projects accessible to the authenticated user",
    {},
    () =>
      withErrorHandling(async () => {
        const projects = await apiClient.get<unknown[]>("/projects");
        const text =
          projects.length === 0
            ? "No projects found."
            : JSON.stringify(projects, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
