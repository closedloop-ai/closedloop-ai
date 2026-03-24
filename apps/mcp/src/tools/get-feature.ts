import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerGetFeature(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-feature",
    {
      description: "Get a single feature by its ID or slug",
      inputSchema: {
        featureId: z
          .string()
          .describe("ID or slug (e.g. FEAT-42) of the feature to retrieve"),
      },
    },
    ({ featureId }) =>
      withErrorHandling(async () => {
        const feature = await apiClient.get<unknown>(
          `/features/${encodePathSegment(featureId)}`
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(feature, null, 2),
            },
          ],
        };
      })
  );
}
