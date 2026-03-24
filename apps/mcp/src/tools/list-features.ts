import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FeatureStatus } from "@repo/api/src/types/feature.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildPaginatedPayload,
  MAX_PAGE_LIMIT,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

export function registerListFeatures(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-features",
    {
      description:
        "List features with optional filters by project, status, assignee, or workstream",
      inputSchema: {
        projectId: z
          .string()
          .optional()
          .describe("Filter by project ID or slug"),
        status: z
          .enum(FeatureStatus)
          .optional()
          .describe("Filter by feature status"),
        assigneeId: z
          .string()
          .optional()
          .describe("Filter by assignee user ID"),
        workstreamId: z
          .string()
          .optional()
          .describe("Filter by workstream ID or slug"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(
            `Maximum number of features to return (1-${MAX_PAGE_LIMIT})`
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ projectId, status, assigneeId, workstreamId, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (status !== undefined) {
          query.status = status;
        }
        if (assigneeId !== undefined) {
          query.assigneeId = assigneeId;
        }
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
        }

        const features = await apiClient.get<unknown[]>("/features", query);
        const payload = buildPaginatedPayload(features, {
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
              description: readString(row.description),
              status: readString(row.status),
              priority: readString(row.priority),
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
        const text = JSON.stringify(payload, null, 2);
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
