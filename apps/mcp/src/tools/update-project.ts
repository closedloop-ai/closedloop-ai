import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerUpdateProject(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "update-project",
    "Update an existing project's name, description, or priority",
    {
      projectId: z.string().describe("ID of the project to update"),
      name: z.string().optional().describe("New name for the project"),
      description: z
        .string()
        .optional()
        .describe("New description for the project"),
      priority: z
        .enum(["NOT_SET", "LOW", "MEDIUM", "HIGH"])
        .optional()
        .describe("New priority level for the project"),
    },
    ({ projectId, name, description, priority }) =>
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
