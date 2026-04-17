import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DocumentType,
  type DocumentWithWorkstream,
} from "@repo/api/src/types/document.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  DOCUMENT_DOC_HELP,
  describeIdOrSlug,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the list-documents tool on the given MCP server.
 * Calls GET /documents with optional query filters for projectId, type, workstreamId, and assigneeId.
 */
export function registerListDocuments(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-documents",
    {
      description:
        "List documents: PRDs, implementation plans, and templates. Filter by project, workstream, type, or assignee.",
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Project", "PROJ-7")),
        workstreamId: z
          .string()
          .optional()
          .describe(describeIdOrSlug("Workstream", "WORK-3")),
        assigneeId: z
          .string()
          .optional()
          .describe("Filter by assignee user ID"),
        type: z
          .enum(DocumentType)
          .optional()
          .describe(`${DOCUMENT_DOC_HELP} Filter by type.`),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(`Maximum documents to return (1-${MAX_PAGE_LIMIT})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ projectId, workstreamId, assigneeId, type, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
        }
        if (assigneeId !== undefined) {
          query.assigneeId = assigneeId;
        }
        if (type !== undefined) {
          query.type = type;
        }

        const documents = await apiClient.get<DocumentWithWorkstream[]>(
          "/documents",
          query
        );
        const payload = buildPaginatedPayload(documents, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            const assigneeRaw = asRecord(row.assignee);
            const projectRaw = asRecord(row.project);
            const workstreamRaw = asRecord(row.workstream);
            return {
              id: readString(row.id),
              title: readString(row.title),
              slug: readString(row.slug),
              type: readString(row.type),
              status: readString(row.status),
              snippet: readString(row.snippet),
              projectId: readString(row.projectId),
              workstreamId: readString(row.workstreamId),
              assigneeId: readString(row.assigneeId),
              createdAt: readString(row.createdAt),
              updatedAt: readString(row.updatedAt),
              assignee: row.assignee
                ? {
                    id: readString(assigneeRaw.id),
                    email: readString(assigneeRaw.email),
                    firstName: readString(assigneeRaw.firstName),
                    lastName: readString(assigneeRaw.lastName),
                    avatarUrl: readString(assigneeRaw.avatarUrl),
                  }
                : null,
              project: row.project
                ? { name: readString(projectRaw.name) }
                : null,
              workstream: row.workstream
                ? { title: readString(workstreamRaw.title) }
                : null,
            };
          },
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}
