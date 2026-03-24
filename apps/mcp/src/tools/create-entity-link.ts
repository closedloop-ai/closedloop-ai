import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { EntityType } from "@repo/api/src/types/entity-link.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { LINK_TYPE_VALUES } from "../tool-enums.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerCreateEntityLink(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-entity-link",
    {
      description:
        "Create a link between two entities (e.g., artifact to feature, workstream to artifact)",
      inputSchema: {
        sourceId: z
          .string()
          .describe(
            "ID or slug of the source entity (slug supported for artifacts and features only)"
          ),
        sourceType: z.enum(EntityType).describe("Type of the source entity"),
        targetId: z
          .string()
          .describe(
            "ID or slug of the target entity (slug supported for artifacts and features only)"
          ),
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
