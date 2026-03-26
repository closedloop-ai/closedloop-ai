import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  FEATURE_HELP,
  withErrorHandling,
} from "./tool-utils.js";

export function registerCreateFeature(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-feature",
    {
      description:
        "Create a feature, which represents an issue or work item in a project.",
      inputSchema: {
        title: z.string().describe("Feature or issue title"),
        projectId: z.string().describe(describeIdOrSlug("Project", "PROJ-7")),
        description: z
          .string()
          .optional()
          .describe(`${FEATURE_HELP} Optional description.`),
        priority: z
          .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
          .optional()
          .describe("Priority level of the feature"),
        assigneeId: z
          .string()
          .optional()
          .describe("User ID to assign the feature to"),
      },
    },
    ({ title, projectId, description, priority, assigneeId }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = { title, projectId };
        if (description !== undefined) {
          body.description = description;
        }
        if (priority !== undefined) {
          body.priority = priority;
        }
        if (assigneeId !== undefined) {
          body.assigneeId = assigneeId;
        }

        const feature = await apiClient.post<unknown>("/features", body);
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
