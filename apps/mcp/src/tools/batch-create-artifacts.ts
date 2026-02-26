import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactType } from "@repo/api/src/types/artifact";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

const artifactItemSchema = z.object({
  title: z.string().describe("Title of the artifact"),
  type: z.enum(ArtifactType).describe("Type of the artifact"),
  projectId: z
    .string()
    .optional()
    .describe("ID of the project to associate with"),
  workstreamId: z
    .string()
    .optional()
    .describe("ID of the workstream to associate with"),
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
  server.registerTool(
    "batch-create-artifacts",
    {
      description: "Create multiple artifacts in a single batch operation",
      inputSchema: {
        items: z
          .array(artifactItemSchema)
          .describe("List of artifacts to create"),
      },
    },
    ({ items }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          "/artifacts/batch-create",
          {
            items,
          }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      })
  );
}
