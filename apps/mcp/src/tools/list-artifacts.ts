import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

/**
 * Register the list-artifacts tool on the given MCP server.
 * Calls GET /artifacts with optional query filters for projectId, type, and workstreamId.
 */
export function registerListArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-artifacts",
    "List artifacts with optional filters by projectId, type, and workstreamId",
    {
      projectId: z.string().optional().describe("Filter by project ID"),
      workstreamId: z.string().optional().describe("Filter by workstream ID"),
      type: z
        .enum(["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE"])
        .optional()
        .describe("Filter by artifact type"),
    },
    ({ projectId, workstreamId, type }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
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
      })
  );
}
