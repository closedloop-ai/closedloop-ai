import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  describeIdOrSlug,
  encodePathSegment,
  withErrorHandling,
} from "./tool-utils.js";

export function registerCreateDocumentThread(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "create-document-thread",
    {
      description:
        "Create a comment thread on a document by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim.\n\nWith anchorText, the thread is anchored to that exact text in the document. Without anchorText, an unanchored artifact-level note is created — use this for triage notes or comments that don't reference specific document text.",
      inputSchema: {
        documentId: z
          .string()
          .describe(
            describeIdOrSlug("Document", ["PRD-7", "PLN-12", "FEA-42"])
          ),
        body: z.string().min(1).describe("Comment body text"),
        anchorText: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Exact text in the document to anchor this comment to. Case-sensitive. Must be unique within the document. May span inline formatting (bold/italic) within a single textblock (paragraph, heading, list item, etc.), but cannot cross textblock boundaries. Omit to create an unanchored artifact-level note."
          ),
      },
    },
    ({ documentId, body, anchorText }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/documents/${encodePathSegment(documentId)}/threads`,
          anchorText === undefined ? { body } : { body, anchorText }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      })
  );
}
