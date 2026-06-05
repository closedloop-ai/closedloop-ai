import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerGetDashboardStats(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-dashboard-stats",
    {
      description:
        "Get organization-level counts for artifacts and workstreams.",
    },
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
