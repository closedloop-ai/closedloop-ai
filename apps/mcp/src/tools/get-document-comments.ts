import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CommentThreadWithComments,
  DocumentThreadAnchorStatus as DocumentThreadAnchorStatusType,
} from "@repo/api/src/types/comment.js";
import {
  resolveAnchorStatusKernel,
  ThreadSource,
  ThreadStatus,
} from "@repo/api/src/types/comment.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  buildQuery,
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
        const query = buildQuery({ status });

        const threads = await apiClient.get<CommentThreadWithComments[]>(
          `/documents/${encodePathSegment(documentId)}/threads`,
          query
        );

        const mappedThreads = threads
          .filter((thread) => thread.source !== ThreadSource.Native)
          .map((thread) => ({
            id: thread.id,
            status: thread.status,
            // `source` identifies the backing system. `anchorStatus` identifies
            // whether a document comment is anchored to text or artifact-level.
            source: thread.source,
            anchorStatus: deriveDocumentCommentAnchorStatus(thread),
            artifactId: thread.artifactId,
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

function deriveDocumentCommentAnchorStatus(
  thread: CommentThreadWithComments
): DocumentThreadAnchorStatusType | null {
  // Non-Liveblocks threads carry no legacy `anchorPreview` signal, so restrict
  // the `anchorPreview`-based inference to Liveblocks sources by withholding
  // `anchorPreview` from the shared kernel. An explicit, validated
  // `metadata.anchorStatus` still wins for any source. The MCP surface keeps
  // the kernel's neutral (`null`) result as-is (unlike the web feed, which
  // maps neutral to `artifact-level`).
  return resolveAnchorStatusKernel({
    anchorStatus: thread.metadata?.anchorStatus,
    anchorPreview:
      thread.source === ThreadSource.Liveblocks
        ? thread.metadata?.anchorPreview
        : undefined,
  });
}
