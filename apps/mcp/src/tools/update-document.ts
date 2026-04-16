import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DocumentStatus } from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerUpdateDocument(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "update-document",
    {
      description:
        "Update a document's title or status by ID or slug. Use create-document-version for content edits.",
      inputSchema: {
        documentId: z
          .string()
          .describe(describeIdOrSlug("Document", ["PRD-7", "PLAN-12"])),
        title: z.string().optional().describe("New title for the document"),
        status: z
          .enum(DocumentStatus)
          .optional()
          .describe("New status for the document"),
      },
    },
    ({ documentId, title, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (title !== undefined) {
          body.title = title;
        }
        if (status !== undefined) {
          body.status = status;
        }

        const document = await apiClient.put<unknown>(
          `/documents/${encodePathSegment(documentId)}`,
          body
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(document, null, 2),
            },
          ],
        };
      })
  );
}
