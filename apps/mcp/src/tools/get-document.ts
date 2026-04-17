import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  DOCUMENT_DOC_HELP,
  describeIdOrSlug,
  encodePathSegment,
  readNumber,
  readString,
  truncateString,
  withErrorHandling,
} from "./tool-utils.js";

const DEFAULT_CONTENT_MAX_CHARS = 4000;
const MAX_CONTENT_MAX_CHARS = 120_000;

/**
 * Register the get-document tool on the given MCP server.
 * Calls GET /documents/:documentId to retrieve a single document.
 */
export function registerGetDocument(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-document",
    {
      description:
        "Get one document, such as a PRD, implementation plan, or template, by ID or slug.",
      inputSchema: {
        documentId: z
          .string()
          .describe(describeIdOrSlug("Document", ["PRD-7", "PLAN-12"])),
        includeContent: z
          .boolean()
          .optional()
          .describe(
            `Include the latest version content in the response. ${DOCUMENT_DOC_HELP} Default false.`
          ),
        contentMaxChars: z
          .number()
          .int()
          .min(200)
          .max(MAX_CONTENT_MAX_CHARS)
          .optional()
          .describe(
            `Maximum content characters when includeContent=true (default ${DEFAULT_CONTENT_MAX_CHARS}, max ${MAX_CONTENT_MAX_CHARS})`
          ),
      },
    },
    ({ documentId, includeContent, contentMaxChars }) =>
      withErrorHandling(async () => {
        const response = await apiClient.get<unknown>(
          `/documents/${encodePathSegment(documentId)}`
        );
        const envelope = asRecord(response);
        const row = asRecord(envelope.data ?? response);
        const version = asRecord(row.version);
        const rawContent = readString(version.content) ?? "";
        const resolvedContentMaxChars =
          contentMaxChars ?? DEFAULT_CONTENT_MAX_CHARS;
        const content =
          includeContent === true
            ? truncateString(rawContent, resolvedContentMaxChars)
            : undefined;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  id: readString(row.id),
                  title: readString(row.title),
                  slug: readString(row.slug),
                  type: readString(row.type),
                  status: readString(row.status),
                  projectId: readString(row.projectId),
                  workstreamId: readString(row.workstreamId),
                  latestVersion: readNumber(row.latestVersion),
                  updatedAt: readString(row.updatedAt),
                  version: {
                    id: readString(version.id),
                    version: readNumber(version.version),
                    createdAt: readString(version.createdAt),
                    createdById: readString(version.createdById),
                    contentLength: rawContent.length,
                    ...(includeContent === true ? { content } : {}),
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      })
  );
}
