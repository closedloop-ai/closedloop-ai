import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerCreateFeatureComment(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-feature-comment",
    {
      description: "Create a comment on a feature by ID or slug",
      inputSchema: {
        featureId: z.string().describe("ID or slug of the feature"),
        body: z.string().min(1).describe("Comment body text"),
      },
    },
    ({ featureId, body }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/features/${encodePathSegment(featureId)}/comments`,
          { body }
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
