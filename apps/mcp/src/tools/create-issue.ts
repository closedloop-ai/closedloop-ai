import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateIssue(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-issue",
    {
      description: "Create a new issue in a project",
      inputSchema: {
        title: z.string().describe("Title of the issue"),
        projectId: z
          .string()
          .describe("ID of the project to create the issue in"),
        description: z.string().optional().describe("Description of the issue"),
        priority: z
          .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
          .optional()
          .describe("Priority level of the issue"),
        assigneeId: z
          .string()
          .optional()
          .describe("User ID to assign the issue to"),
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

        const issue = await apiClient.post<unknown>("/issues", body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      })
  );
}
