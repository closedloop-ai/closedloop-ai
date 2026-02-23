import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerUpdateIssue(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "update-issue",
    "Update an existing issue's title, description, status, priority, or assignee",
    {
      issueId: z.string().describe("ID of the issue to update"),
      title: z.string().optional().describe("New title for the issue"),
      description: z
        .string()
        .optional()
        .describe("New description for the issue"),
      status: z
        .enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "CLOSED"])
        .optional()
        .describe("New status for the issue"),
      priority: z
        .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
        .optional()
        .describe("New priority for the issue"),
      assigneeId: z
        .string()
        .optional()
        .describe("New assignee user ID for the issue"),
    },
    ({ issueId, title, description, status, priority, assigneeId }) =>
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

        const issue = await apiClient.put<unknown>(
          `/issues/${encodePathSegment(issueId)}`,
          body
        );
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
