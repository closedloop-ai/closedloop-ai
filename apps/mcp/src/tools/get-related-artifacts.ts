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
      description:
        "Get artifacts related to a given artifact by ID or slug via entity links",
      inputSchema: {
        artifactId: z.string().describe("ID or slug of the artifact"),
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
