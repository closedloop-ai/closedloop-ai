import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  describeIdOrSlug,
  encodePathSegment,
  MAX_PAGE_LIMIT,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListDocumentVersions(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-document-versions",
    {
      description:
        "List saved versions for a document by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim.",
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(
            `Maximum number of document versions to return (1-${MAX_PAGE_LIMIT})`
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ documentId, limit, offset }) =>
      withErrorHandling(async () => {
        const versions = await apiClient.get<unknown[]>(
          `/documents/${encodePathSegment(documentId)}/versions`
        );
        const payload = buildPaginatedPayload(versions, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            const content = readString(row.content);
            return {
              id: readString(row.id),
              version: readNumber(row.version),
              createdAt: readString(row.createdAt),
              createdById: readString(row.createdById),
              contentLength: content?.length ?? null,
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
