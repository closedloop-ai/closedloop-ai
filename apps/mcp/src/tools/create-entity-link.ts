import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EntityType } from "@repo/api/src/types/entity-link.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { LINK_TYPE_VALUES } from "../tool-enums.js";
import { ENTITY_LINK_SLUG_HELP, withErrorHandling } from "./tool-utils.js";

export function registerCreateEntityLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-entity-link",
    {
      description:
        "Create a typed relationship between entities, such as PRD-to-plan or feature-to-artifact.",
      inputSchema: {
        sourceId: z
          .string()
          .describe(`Source entity ID. ${ENTITY_LINK_SLUG_HELP}`),
        sourceType: z.enum(EntityType).describe("Type of the source entity"),
        targetId: z
          .string()
          .describe(`Target entity ID. ${ENTITY_LINK_SLUG_HELP}`),
        targetType: z.enum(EntityType).describe("Type of the target entity"),
        linkType: z.enum(LINK_TYPE_VALUES).describe("Type of the link"),
      },
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
