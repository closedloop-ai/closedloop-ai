import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateExternalLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "create-external-link",
    "Create an external link (PR, Figma, doc, etc.) attached to an entity",
    {
      entityId: z.string().describe("ID of the entity to attach the link to"),
      url: z.string().url().describe("URL of the external link"),
      type: z
        .string()
        .describe(
          "Type of the external link (e.g., PULL_REQUEST, FIGMA, DOCUMENT)"
        ),
      title: z
        .string()
        .optional()
        .describe("Display title for the external link"),
    },
    ({ entityId, url, type, title }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = { entityId, url, type };
        if (title !== undefined) {
          body.title = title;
        }

        const link = await apiClient.post<unknown>("/external-links", body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(link, null, 2),
            },
          ],
        };
      })
  );
}
