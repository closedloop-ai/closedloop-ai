import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { withErrorHandling } from "./tool-utils.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

type ArtifactListItem = {
  id: string | null;
  title: string | null;
  slug: string | null;
  type: string | null;
  status: string | null;
  projectId: string | null;
  workstreamId: string | null;
  updatedAt: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toArtifactListItem(value: unknown): ArtifactListItem {
  const row = asRecord(value);
  return {
    id: readString(row.id),
    title: readString(row.title),
    slug: readString(row.slug),
    type: readString(row.type),
    status: readString(row.status),
    projectId: readString(row.projectId),
    workstreamId: readString(row.workstreamId),
    updatedAt: readString(row.updatedAt),
  };
}

/**
 * Register the list-artifacts tool on the given MCP server.
 * Calls GET /artifacts with optional query filters for projectId, type, and workstreamId.
 */
export function registerListArtifacts(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.tool(
    "list-artifacts",
    "List artifacts with optional filters by projectId, type, and workstreamId",
    {
      projectId: z.string().optional().describe("Filter by project ID"),
      workstreamId: z.string().optional().describe("Filter by workstream ID"),
      type: z
        .enum(["PRD", "IMPLEMENTATION_PLAN", "TEMPLATE"])
        .optional()
        .describe("Filter by artifact type"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LIMIT)
        .optional()
        .describe(
          `Maximum artifacts to return per call (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Starting offset for pagination (default 0)"),
    },
    ({ projectId, workstreamId, type, limit, offset }) =>
      withErrorHandling(async () => {
        const query: Record<string, string> = {};
        if (projectId !== undefined) {
          query.projectId = projectId;
        }
        if (workstreamId !== undefined) {
          query.workstreamId = workstreamId;
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

        const resolvedOffset = offset ?? 0;
        const resolvedLimit = limit ?? DEFAULT_LIMIT;
        const page = artifacts
          .slice(resolvedOffset, resolvedOffset + resolvedLimit)
          .map(toArtifactListItem);
        const hasMore = resolvedOffset + page.length < artifacts.length;
        const nextOffset = hasMore ? resolvedOffset + page.length : null;

        const text = JSON.stringify(
          {
            total: artifacts.length,
            offset: resolvedOffset,
            limit: resolvedLimit,
            returned: page.length,
            hasMore,
            nextOffset,
            items: page,
          },
          null,
          2
        );
        return {
          content: [{ type: "text" as const, text }],
        };
      })
  );
}
