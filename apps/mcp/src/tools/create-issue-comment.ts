import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerCreateIssueComment(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-issue-comment",
    {
      description: "Create a comment on an issue",
      inputSchema: {
        issueId: z.string().describe("ID of the issue to comment on"),
        body: z.string().min(1).describe("Comment body text"),
      },
    },
    ({ issueId, body }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/issues/${encodePathSegment(issueId)}/comments`,
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
