import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerGetGoogleStatus(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-google-status",
    {
      description:
        "Check the Google integration connection status for the organization.",
    },
    () =>
      withErrorHandling(async () => {
        const status = await apiClient.get<unknown>("/integrations/google");
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
