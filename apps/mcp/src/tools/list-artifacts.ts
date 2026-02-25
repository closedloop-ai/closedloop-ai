import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactType } from "@repo/api/src/types/artifact.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Register the list-artifacts tool on the given MCP server.
 * Calls GET /artifacts with optional query filters for projectId, type, workstreamId, and assigneeId.
 */
export function registerListArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-artifacts",
    {
      description:
        "List artifacts with optional filters by projectId, type, workstreamId, and assigneeId",
      inputSchema: {
        projectId: z.string().optional().describe("Filter by project ID"),
        workstreamId: z.string().optional().describe("Filter by workstream ID"),
        assigneeId: z
          .string()
          .optional()
          .describe("Filter by assignee user ID"),
        type: z
          .enum(ArtifactType)
          .optional()
          .describe("Filter by artifact type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(`Maximum artifacts to return (1-${MAX_PAGE_LIMIT})`),
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

        const artifacts = await apiClient.get<unknown[]>("/artifacts", query);
        const payload = buildPaginatedPayload(artifacts, {
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
