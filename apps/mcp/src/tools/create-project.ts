import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-project",
    {
      description:
        "Create a project, the top-level container for workstreams, features, and artifacts.",
      inputSchema: {
        name: z.string().describe("Name of the project"),
        description: z
          .string()
          .optional()
          .describe("Description of the project"),
        priority: z
          .enum(Priority)
          .optional()
          .describe("Priority level of the project"),
        status: z
          .enum(ProjectStatus)
          .optional()
          .describe("Initial status for the project"),
      },
    },
    ({ name, description, priority, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = { name };
        if (description !== undefined) {
          body.description = description;
        }
        if (priority !== undefined) {
          body.priority = priority;
        }
        if (status !== undefined) {
          body.status = status;
        }

        const project = await apiClient.post<unknown>("/projects", body);
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
