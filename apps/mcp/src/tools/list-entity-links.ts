import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { ENTITY_TYPE_VALUES, LINK_TYPE_VALUES } from "../tool-enums.js";
import { withErrorHandling } from "./tool-utils.js";

export function registerListEntityLinks(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-entity-links",
    "List links between entities (artifacts, issues, workstreams, etc.)",
    {
      entityId: z.string().describe("ID of the entity to list links for"),
      entityType: z.enum(ENTITY_TYPE_VALUES).describe("Type of the entity"),
      linkType: z
        .enum(LINK_TYPE_VALUES)
        .optional()
        .describe("Filter by link type"),
      direction: z
        .enum(["source", "target", "both"])
        .optional()
        .describe(
          "Filter by link direction: 'source' for outgoing links, 'target' for incoming links, 'both' for all"
        ),
    },
    ({ entityId, entityType, linkType, direction }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = { entityId, entityType };
        if (linkType !== undefined) {
          query.linkType = linkType;
        }
        if (direction !== undefined) {
          query.direction = direction;
        }

        const links = await apiClient.get<unknown[]>("/entity-links", query);
        const text =
          links.length === 0
            ? "No entity links found."
            : JSON.stringify(links, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
