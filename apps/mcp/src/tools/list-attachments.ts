import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AttachmentPurposeSelector } from "@repo/api/src/types/attachment.js";
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

/**
 * Register the list-attachments tool on the given MCP server.
 * Calls GET /documents/:entityId/attachments. Features are documents
 * (type=FEATURE), so feature IDs/slugs resolve through the same endpoint.
 */
export function registerListAttachments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-attachments",
    {
      description:
        "List file attachments for a document (PRD, implementation plan, feature, or template) by UUID or slug. Supports limit/offset pagination and returns a paginated envelope (total, offset, limit, returned, hasMore, nextOffset, items) whose items include id, artifactId, filename, mimeType, sizeBytes, purpose, createdAt, createdById, and an optional previewUrl (present only for image attachments). Pass the user's slug verbatim.",
      inputSchema: {
        entityId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        purpose: z
          .enum([
            AttachmentPurposeSelector.Context,
            AttachmentPurposeSelector.Inline,
            AttachmentPurposeSelector.All,
          ])
          .optional()
          .describe(
            "Optional attachment purpose selector. Omit to preserve the default context list."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(
            `Maximum number of attachments to return (1-${MAX_PAGE_LIMIT})`
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ entityId, purpose, limit, offset }) =>
      withErrorHandling(async () => {
        const query = purpose
          ? `?${new URLSearchParams({ purpose }).toString()}`
          : "";
        const path = `/documents/${encodePathSegment(entityId)}/attachments${query}`;
        const attachments = await apiClient.get<unknown[]>(path);
        const payload = buildPaginatedPayload(attachments, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            const previewUrl = readString(row.previewUrl);
            return {
              id: readString(row.id),
              artifactId: readString(row.artifactId),
              filename: readString(row.filename),
              mimeType: readString(row.mimeType),
              sizeBytes: readNumber(row.sizeBytes),
              purpose: readString(row.purpose),
              createdAt: readString(row.createdAt),
              createdById: readString(row.createdById),
              // Preserve the API's wire shape: previewUrl is omitted (not null)
              // for non-image attachments or when preview-URL signing fails.
              ...(previewUrl === null ? {} : { previewUrl }),
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
