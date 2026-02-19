import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";

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
        .string()
        .describe(
          "Type of the artifact (e.g. PRD, ISSUE, IMPLEMENTATION_PLAN)"
        ),
      projectId: z.string().describe("ID of the project to associate with"),
      content: z.string().describe("Content/body of the artifact"),
    },
    async ({ title, type, projectId, content }) => {
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
    }
  );
}
