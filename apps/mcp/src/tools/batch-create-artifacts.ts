import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";

const artifactItemSchema = z.object({
  title: z.string().describe("Title of the artifact"),
  type: z.string().describe("Type of the artifact"),
  projectId: z.string().describe("ID of the project to associate with"),
  content: z.string().describe("Content/body of the artifact"),
});

/**
 * Register the batch-create-artifacts tool on the given MCP server.
 * Calls POST /artifacts/batch-create to create multiple artifacts at once.
 */
export function registerBatchCreateArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "batch-create-artifacts",
    "Create multiple artifacts in a single batch operation",
    {
      items: z
        .array(artifactItemSchema)
        .describe("List of artifacts to create"),
    },
    async ({ items }) => {
      const result = await apiClient.post<unknown>("/artifacts/batch-create", {
        items,
      });
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
