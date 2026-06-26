import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DocumentStatus } from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildDocumentUrlFromRecord,
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
        "Update a document's title, status, project, or assignee by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim. Use create-document-version for content edits.\n\nStatus lifecycle: DRAFT → IN_PROGRESS → IN_REVIEW → APPROVED → EXECUTED → DONE (or OBSOLETE).\nUpdate status as work progresses — set IN_PROGRESS when starting, IN_REVIEW when a PR is created, DONE when merged.",
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
        assigneeId: z
          .string()
          .uuid()
          .nullable()
          .optional()
          .describe(
            "UUID of the user to assign this document to. Use list-users to find valid user IDs. Pass null to unassign."
          ),
      },
    },
    ({ documentId, projectId, title, status, assigneeId }) =>
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
        if (assigneeId !== undefined) {
          body.assigneeId = assigneeId;
        }

        const document = await apiClient.put<unknown>(
          `/documents/${encodePathSegment(documentId)}`,
          body
        );
        const webUrl = buildDocumentUrlFromRecord(asRecord(document));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...asRecord(document), webUrl }, null, 2),
            },
          ],
        };
      })
  );
}
