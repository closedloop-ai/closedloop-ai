import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { ENTITY_TYPE_VALUES, LINK_TYPE_VALUES } from "../tool-enums.js";
import {
  asRecord,
  buildPaginatedPayload,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListEntityLinks(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-entity-links",
    {
      description:
        "List links between entities (artifacts, issues, workstreams, etc.)",
      inputSchema: {
        entityId: z
          .string()
          .describe(
            "ID or slug of the entity (slug supported for artifacts and issues only)"
          ),
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
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(
            `Maximum number of entity links to return (1-${MAX_PAGE_LIMIT})`
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ entityId, entityType, linkType, direction, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = { entityId, entityType };
        if (linkType !== undefined) {
          query.linkType = linkType;
        }
        if (direction !== undefined) {
          query.direction = direction;
        }

        const links = await apiClient.get<unknown[]>("/entity-links", query);
        const payload = buildPaginatedPayload(links, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            return {
              id: readString(row.id),
              sourceId: readString(row.sourceId),
              sourceType: readString(row.sourceType),
              targetId: readString(row.targetId),
              targetType: readString(row.targetType),
              linkType: readString(row.linkType),
              createdAt: readString(row.createdAt),
            };
          },
        });
        const text = JSON.stringify(payload, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
