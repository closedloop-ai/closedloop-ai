import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerGetMe(server: McpServer, apiClient: ApiClient): void {
  server.registerTool(
    "get-me",
    { description: "Get the authenticated user's profile and identity." },
    () =>
      withErrorHandling(async () => {
        const user = await apiClient.get<unknown>("/me");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(user, null, 2),
            },
          ],
        };
      })
  );
}
