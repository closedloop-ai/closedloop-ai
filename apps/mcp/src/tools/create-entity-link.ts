import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateEntityLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "create-entity-link",
    "Create a link between two entities (e.g., artifact to issue, workstream to artifact)",
    {
      sourceId: z.string().describe("ID of the source entity"),
      targetId: z.string().describe("ID of the target entity"),
      linkType: z
        .string()
        .describe("Type of the link (e.g., PARENT, RELATED, DEPENDS_ON)"),
    },
    ({ sourceId, targetId, linkType }) =>
      withErrorHandling(async () => {
        const link = await apiClient.post<unknown>("/entity-links", {
          sourceId,
          targetId,
          linkType,
        });
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
