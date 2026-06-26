import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DocumentType } from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildDocumentUrlFromRecord,
  DOCUMENT_DOC_HELP,
  describeIdOrSlug,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the create-document tool on the given MCP server.
 * Calls POST /documents to create a new document.
 */
export function registerCreateDocument(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-document",
    {
      description:
        "Create a document — a PRD, implementation plan, feature, or template — and attach it to a project. The assigned slug (PRD-*, PLN-*, FEA-*) is returned in the response and is the preferred handle for future calls.",
      inputSchema: {
        title: z.string().describe("Title of the document"),
        type: z
          .enum(DocumentType)
          .describe(`${DOCUMENT_DOC_HELP} Choose the document type.`),
        projectId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Project", "PRO-7")),
        content: z.string().describe("Initial document content/body"),
      },
    },
    ({ title, type, projectId, content }) =>
      withErrorHandling(async () => {
        const body: Record<string, string> = {
          title,
          type,
          content,
        };
        if (projectId !== undefined) {
          body.projectId = projectId;
        }
        const response = await apiClient.post<unknown>("/documents", body);
        const envelope = asRecord(response);
        const row = asRecord(envelope.data ?? response);
        const webUrl = buildDocumentUrlFromRecord(row);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...row, webUrl }, null, 2),
            },
          ],
        };
      })
  );
}
