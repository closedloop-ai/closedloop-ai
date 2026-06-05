import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerGetGithubStatus(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-github-status",
    {
      description:
        "Check the GitHub integration connection status for the organization",
    },
    () =>
      withErrorHandling(async () => {
        const status = await apiClient.get<unknown>("/integrations/github");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      })
  );
}
