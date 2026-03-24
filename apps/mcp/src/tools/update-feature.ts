import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import { FeatureStatus } from "@repo/api/src/types/feature.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerUpdateFeature(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-feature",
    {
      description:
        "Update an existing feature's title, description, status, priority, or assignee by ID or slug",
      inputSchema: {
        featureId: z.string().describe("ID or slug of the feature to update"),
        title: z.string().optional().describe("New title for the feature"),
        description: z
          .string()
          .optional()
          .describe("New description for the feature"),
        status: z
          .enum(FeatureStatus)
          .optional()
          .describe("New status for the feature"),
        priority: z
          .enum(Priority)
          .optional()
          .describe("New priority for the feature"),
        assigneeId: z
          .string()
          .optional()
          .describe("New assignee user ID for the feature"),
      },
    },
    ({ featureId, title, description, status, priority, assigneeId }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (title !== undefined) {
          body.title = title;
        }
        if (description !== undefined) {
          body.description = description;
        }
        if (status !== undefined) {
          body.status = status;
        }
        if (priority !== undefined) {
          body.priority = priority;
        }
        if (assigneeId !== undefined) {
          body.assigneeId = assigneeId;
        }

        const feature = await apiClient.put<unknown>(
          `/features/${encodePathSegment(featureId)}`,
          body
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
