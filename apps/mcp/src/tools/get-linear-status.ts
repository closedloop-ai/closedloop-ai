import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerGetLinearStatus(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-linear-status",
    {
      description:
        "Check the Linear integration connection status for the organization",
    },
    () =>
      withErrorHandling(async () => {
        const status = await apiClient.get<unknown>("/integrations/linear");
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
