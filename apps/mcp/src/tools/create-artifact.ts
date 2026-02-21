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
    "Create a new artifact with the given title, type, content, and project/workstream association",
    {
      title: z.string().describe("Title of the artifact"),
      type: z
        .enum(["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE"])
        .describe("Type of the artifact"),
      projectId: z
        .string()
        .optional()
        .describe("ID of the project to associate with"),
      workstreamId: z
        .string()
        .optional()
        .describe("ID of the workstream to associate with"),
      content: z.string().describe("Content/body of the artifact"),
    },
    ({ title, type, projectId, workstreamId, content }) =>
      withErrorHandling(async () => {
        const body: Record<string, string> = {
          title,
          type,
          content,
        };
        if (projectId !== undefined) {
          body.projectId = projectId;
        }
        if (workstreamId !== undefined) {
          body.workstreamId = workstreamId;
        }
        const artifact = await apiClient.post<unknown>("/artifacts", body);
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
