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
 * Register the get-artifact-comments tool on the given MCP server.
 * Calls GET /artifacts/:artifactId/threads to retrieve comment threads for an artifact.
 */
export function registerGetArtifactComments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-artifact-comments",
    {
      description:
        "Get comment threads and their comments for an artifact document by ID or slug.",
      inputSchema: {
        artifactId: z
          .string()
          .describe(describeIdOrSlug("Artifact", ["PRD-7", "PLAN-12"])),
        status: z
          .enum(ThreadStatus)
          .optional()
          .describe("Filter threads by status. Omit to return all threads."),
      },
    },
    ({ artifactId, status }) =>
      withErrorHandling(async () => {
        const threads = await apiClient.get<CommentThreadWithComments[]>(
          `/artifacts/${encodePathSegment(artifactId)}/threads${status ? `?status=${status}` : ""}`
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
