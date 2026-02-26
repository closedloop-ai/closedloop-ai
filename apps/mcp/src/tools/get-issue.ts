import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { encodePathSegment, withErrorHandling } from "./tool-utils.js";

export function registerGetIssue(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-issue",
    {
      description: "Get a single issue by its ID",
      inputSchema: {
        issueId: z.string().describe("ID of the issue to retrieve"),
      },
    },
    ({ issueId }) =>
      withErrorHandling(async () => {
        const issue = await apiClient.get<unknown>(
          `/issues/${encodePathSegment(issueId)}`
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
