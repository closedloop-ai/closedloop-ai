import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common.js";
import { ProjectStatus } from "@repo/api/src/types/project.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerUpdateProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-project",
    {
      description:
        "Update a project's metadata or status by UUID or slug (PRO-*). Pass the user's slug verbatim.",
      inputSchema: {
        projectId: z.string().describe(describeIdOrSlug("Project", "PRO-7")),
        name: z.string().optional().describe("New name for the project"),
        description: z
          .string()
          .optional()
          .describe("New description for the project"),
        priority: z
          .enum(Priority)
          .optional()
          .describe("New priority level for the project"),
        status: z
          .enum(ProjectStatus)
          .optional()
          .describe("New status for the project"),
      },
    },
    ({ projectId, name, description, priority, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (name !== undefined) {
          body.name = name;
        }
        if (description !== undefined) {
          body.description = description;
        }
        if (priority !== undefined) {
          body.priority = priority;
        }
        if (status !== undefined) {
          body.status = status;
        }

        const project = await apiClient.put<unknown>(
          `/projects/${encodePathSegment(projectId)}`,
          body
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(project, null, 2),
            },
          ],
        };
      })
  );
}
