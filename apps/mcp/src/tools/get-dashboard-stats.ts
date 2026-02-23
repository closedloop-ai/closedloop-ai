import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerGetDashboardStats(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "get-dashboard-stats",
    "Get artifact counts and workstream metrics for the organization dashboard",
    {},
    () =>
      withErrorHandling(async () => {
        const stats = await apiClient.get<unknown>("/dashboard/stats");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      })
  );
}
