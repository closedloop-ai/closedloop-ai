import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CommentThreadWithComments } from "@repo/api/src/types/comment.js";
import { ThreadStatus } from "@repo/api/src/types/comment.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the get-document-comments tool on the given MCP server.
 * Calls GET /documents/:documentId/threads to retrieve comment threads for a document.
 */
export function registerGetDocumentComments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-document-comments",
    {
      description:
        "Get comment threads and their comments for a document by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim.",
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        status: z
          .enum(ThreadStatus)
          .optional()
          .describe("Filter threads by status. Omit to return all threads."),
      },
    },
    ({ documentId, status }) =>
      withErrorHandling(async () => {
        const threads = await apiClient.get<CommentThreadWithComments[]>(
          `/documents/${encodePathSegment(documentId)}/threads${status ? `?status=${status}` : ""}`
        );

        const mappedThreads = threads.map((thread) => ({
          id: thread.id,
          status: thread.status,
          entityId: thread.entityId,
          entityType: thread.entityType,
          createdAt: thread.createdAt,
          comments: thread.comments.map((c) => ({
            id: c.id,
            plainText: c.plainText,
            createdAt: c.createdAt,
            author: c.authorId,
          })),
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(mappedThreads, null, 2),
            },
          ],
        };
      })
  );
}
