import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GlobalSearchResponse } from "@repo/api/src/types/search.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildDocumentUrlFromRecord,
  DOCUMENT_DOC_HELP,
  extractArrayItems,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 200;

/** Shape a BasicUser assignee row, or null when absent. */
function shapeAssignee(value: unknown) {
  if (!value) {
    return null;
  }
  const raw = asRecord(value);
  return {
    id: readString(raw.id),
    email: readString(raw.email),
    firstName: readString(raw.firstName),
    lastName: readString(raw.lastName),
    avatarUrl: readString(raw.avatarUrl),
  };
}

/** Shape one API document search row for the `search` MCP response. */
function shapeSearchDocument(value: unknown) {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    title: readString(row.title),
    slug: readString(row.slug),
    type: readString(row.type),
    status: readString(row.status),
    priority: readString(row.priority),
    projectName: readString(row.projectName),
    assignee: shapeAssignee(row.assignee),
    updatedAt: readString(row.updatedAt),
    webUrl: buildDocumentUrlFromRecord(row),
  };
}

/** Shape one API project search row for the `search` MCP response. */
function shapeSearchProject(value: unknown) {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    name: readString(row.name),
    slug: readString(row.slug),
    status: readString(row.status),
    priority: readString(row.priority),
    teamName: readString(row.teamName),
    teamId: readString(row.teamId),
    assignee: shapeAssignee(row.assignee),
    updatedAt: readString(row.updatedAt),
  };
}

/**
 * Register the search tool on the given MCP server.
 * Calls GET /search?q= and shapes the existing documents + projects response
 * (`GlobalSearchResponse`) into a compact free-text search result.
 */
export function registerSearch(server: McpServer, apiClient: ApiClient): void {
  server.registerTool(
    "search",
    {
      description: `Free-text search across projects and documents. Matches documents by title, slug, type, and tag, and projects by name, slug, and description. ${DOCUMENT_DOC_HELP} Returned \`slug\` values are the preferred user-facing handles for follow-up calls.`,
      inputSchema: {
        q: z
          .string()
          .min(MIN_QUERY_LENGTH)
          .max(MAX_QUERY_LENGTH)
          .describe(
            `Free-text search query (${MIN_QUERY_LENGTH}-${MAX_QUERY_LENGTH} characters).`
          ),
      },
    },
    ({ q }) =>
      withErrorHandling(async () => {
        const response = await apiClient.get<GlobalSearchResponse>("/search", {
          q,
        });
        const record = asRecord(response);
        const documents = extractArrayItems<unknown>(
          record.documents ?? []
        ).map(shapeSearchDocument);
        const projects = extractArrayItems<unknown>(record.projects ?? []).map(
          shapeSearchProject
        );
        const payload = {
          query: readString(record.query) ?? q,
          documentCount: documents.length,
          projectCount: projects.length,
          documents,
          projects,
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}
