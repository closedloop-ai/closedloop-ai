import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  buildPaginatedPayload,
  MAX_PAGE_LIMIT,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * `TeamWithCounts` as it arrives over the wire. The shared contract types
 * `createdAt`/`updatedAt` as `Date`, which JSON cannot carry, so this narrows
 * only the fields the tool reads rather than restating the contract.
 */
type TeamWireRow = {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
  memberCount?: unknown;
  projectCount?: unknown;
  updatedAt?: unknown;
};

/**
 * Register the list-teams tool on the given MCP server.
 *
 * This is the complete team choice set for a headless caller (ISS-6966).
 * `create-project` requires a team, and its 400 names the org's teams inline,
 * but that sentence is bounded by a character budget — an org past the budget
 * has teams the error cannot name. This tool is how those are reached.
 */
export function registerListTeams(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-teams",
    {
      description:
        "List the teams in the authenticated user's organization. A project must belong to a team, so use this to find the teamId that create-project requires and update-project accepts. Teams are identified by UUID only (no slug form).",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_LIMIT)
          .optional()
          .describe(`Maximum number of teams to return (1-${MAX_PAGE_LIMIT})`),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Starting offset for pagination (default 0)"),
      },
    },
    ({ limit, offset }) =>
      withErrorHandling(async () => {
        const teams = await apiClient.get<TeamWireRow[]>("/teams");
        const payload = buildPaginatedPayload<TeamWireRow>(teams, {
          limit,
          offset,
          mapItem: (row) => ({
            id: readString(row.id),
            name: readString(row.name),
            slug: readString(row.slug),
            memberCount: readNumber(row.memberCount),
            projectCount: readNumber(row.projectCount),
            updatedAt: readString(row.updatedAt),
          }),
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}
