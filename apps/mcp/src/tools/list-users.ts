import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerListUsers(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool("list-users", "List all users in the organization", {}, () =>
    withErrorHandling(async () => {
      const users = await apiClient.get<unknown[]>("/users");
      const text =
        users.length === 0 ? "No users found." : JSON.stringify(users, null, 2);
      return {
        content: [{ type: "text" as const, text }],
      };
    })
  );
}
