import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerGetFeature(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-feature",
    {
      description:
        "Get one feature, meaning an issue or work item, by ID or slug.",
      inputSchema: {
        featureId: z.string().describe(describeIdOrSlug("Feature", "FEAT-42")),
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
