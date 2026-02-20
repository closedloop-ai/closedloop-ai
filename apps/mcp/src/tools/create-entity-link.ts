import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EntityType, LinkType } from "@repo/api/src/types/entity-link";
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
      sourceType: z
        .nativeEnum(EntityType)
        .describe("Type of the source entity"),
      targetId: z.string().describe("ID of the target entity"),
      targetType: z
        .nativeEnum(EntityType)
        .describe("Type of the target entity"),
      linkType: z.nativeEnum(LinkType).describe("Type of the link"),
    },
    ({ sourceId, sourceType, targetId, targetType, linkType }) =>
      withErrorHandling(async () => {
        const link = await apiClient.post<unknown>("/entity-links", {
          sourceId,
          sourceType,
          targetId,
          targetType,
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
