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
        "Create a comment thread on a document by UUID or slug (PRD-*, PLN-*, FEA-*). Pass the user's slug verbatim.",
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
          .describe(
            "Exact text in the document to anchor this comment to. Case-sensitive. Must be unique within the document. May span inline formatting (bold/italic) within a single textblock (paragraph, heading, list item, etc.), but cannot cross textblock boundaries."
          ),
      },
    },
    ({ documentId, body, anchorText }) =>
      withErrorHandling(async () => {
        const result = await apiClient.post<unknown>(
          `/documents/${encodePathSegment(documentId)}/threads`,
          { body, anchorText }
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
