import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

/**
 * Register the get-artifact tool on the given MCP server.
 * Calls GET /artifacts/:artifactId to retrieve a single artifact.
 */
export function registerGetArtifact(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "get-artifact",
    "Retrieve a single artifact by its ID",
    {
      artifactId: z.string().describe("ID of the artifact to retrieve"),
    },
    ({ artifactId }) =>
      withErrorHandling(async () => {
        const artifact = await apiClient.get<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}`
        );
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
