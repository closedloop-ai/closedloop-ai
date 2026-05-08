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
        "Update a document's title, status, or project by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim. Use create-document-version for content edits.",
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        projectId: z
          .string()
          .optional()
          .describe(
            describeIdOrSlug("Project", "PRO-7") +
              ". Moves the document to this project."
          ),
        title: z.string().optional().describe("New title for the document"),
        status: z
          .enum(DocumentStatus)
          .optional()
          .describe("New status for the document"),
      },
    },
    ({ documentId, projectId, title, status }) =>
      withErrorHandling(async () => {
        const body: Record<string, unknown> = {};
        if (projectId !== undefined) {
          body.projectId = projectId;
        }
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
