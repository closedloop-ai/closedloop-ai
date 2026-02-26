import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerGetRelatedArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-related-artifacts",
    {
      description: "Get artifacts related to a given artifact via entity links",
      inputSchema: {
        artifactId: z
          .string()
          .describe("ID of the artifact to find related artifacts for"),
      },
    },
    ({ artifactId }) =>
      withErrorHandling(async () => {
        const related = await apiClient.get<unknown>(
          `/artifacts/${encodePathSegment(artifactId)}/related`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(related, null, 2),
            },
          ],
        };
      })
  );
}
