import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

/**
 * Register the create-artifact tool on the given MCP server.
 * Calls POST /artifacts to create a new artifact.
 */
export function registerCreateArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "create-artifact",
    "Create a new artifact with the given title, type, project, and content",
    {
      title: z.string().describe("Title of the artifact"),
      type: z
        .enum(["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE"])
        .describe("Type of the artifact"),
      projectId: z.string().describe("ID of the project to associate with"),
      content: z.string().describe("Content/body of the artifact"),
    },
    ({ title, type, projectId, content }) =>
      withErrorHandling(async () => {
        const artifact = await apiClient.post<unknown>("/artifacts", {
          title,
          type,
          projectId,
          content,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(artifact, null, 2),
            },
          ],
        };
      })
  );
}
