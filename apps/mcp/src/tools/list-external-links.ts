import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerListExternalLinks(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-external-links",
    "List external links (PRs, Figma, docs, etc.) attached to an entity",
    {
      entityId: z
        .string()
        .describe("ID of the entity to list external links for"),
    },
    ({ entityId }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = { entityId };

        const links = await apiClient.get<unknown[]>("/external-links", query);
        const text =
          links.length === 0
            ? "No external links found."
            : JSON.stringify(links, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
