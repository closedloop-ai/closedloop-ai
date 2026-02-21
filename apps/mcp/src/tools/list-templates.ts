import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerListTemplates(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-templates",
    "List available artifact templates for the organization",
    {},
    () =>
      withErrorHandling(async () => {
        const templates = await apiClient.get<unknown[]>("/templates");
        const text =
          templates.length === 0
            ? "No templates found."
            : JSON.stringify(templates, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
