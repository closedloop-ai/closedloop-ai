import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
 * Calls GET /artifacts with optional query filters for projectId, type, workstreamId, and ownerId.
 */
export function registerListArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-artifacts",
    "List artifacts with optional filters by projectId, type, workstreamId, and ownerId",
    {
      projectId: z.string().optional().describe("Filter by project ID"),
      workstreamId: z.string().optional().describe("Filter by workstream ID"),
      ownerId: z.string().optional().describe("Filter by owner user ID"),
      type: z
        .enum(["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE"])
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
    ({ projectId, workstreamId, ownerId, type, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
        }
        if (ownerId !== undefined) {
          query.ownerId = ownerId;
        }
        if (type !== undefined) {
          query.type = type;
        }

        const artifacts = await apiClient.get<unknown[]>("/artifacts", query);
        if (artifacts.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No artifacts found." }],
          };
        }

        const payload = buildPaginatedPayload(artifacts, {
          limit,
          offset,
          mapItem: (value) => {
            const row = asRecord(value);
            const ownerRaw = asRecord(row.owner);
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
              ownerId: readString(row.ownerId),
              createdAt: readString(row.createdAt),
              updatedAt: readString(row.updatedAt),
              owner: row.owner
                ? {
                    id: readString(ownerRaw.id),
                    firstName: readString(ownerRaw.firstName),
                    lastName: readString(ownerRaw.lastName),
                    avatarUrl: readString(ownerRaw.avatarUrl),
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
        const text = JSON.stringify(payload, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
