import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { asRecord, withErrorHandling } from "./tool-utils.js";

export function registerGetMe(server: McpServer, apiClient: ApiClient): void {
  server.tool("get-me", "Get the authenticated user's profile", {}, () =>
    withErrorHandling(async () => {
      const response = await apiClient.get<unknown>("/me");
      const user = asRecord(response).data ?? response;
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
