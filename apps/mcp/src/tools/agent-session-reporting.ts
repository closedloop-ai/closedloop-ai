import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AGENT_SESSION_VIEWER_SCOPE_OPTIONS,
  type AgentSessionAnalytics,
  type AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { buildQuery, withErrorHandling } from "./tool-utils.js";

/**
 * Shared optional filters for the read-only agent-session reporting tools. Maps
 * directly to the query params accepted by the `/agent-sessions/usage` and
 * `/agent-sessions/analytics` routes (`baseAgentSessionQuerySchema`); the API
 * validates values and enforces org/team/self viewer scoping server-side.
 */
const agentSessionReportingInputSchema = {
  startDate: z
    .string()
    .optional()
    .describe(
      "Only include sessions started on or after this ISO 8601 date or timestamp (e.g. 2026-07-01)."
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      "Only include sessions started on or before this ISO 8601 date or timestamp (e.g. 2026-07-31)."
    ),
  harness: z
    .string()
    .optional()
    .describe(
      'Filter to a single agent harness (e.g. "claude-code", "codex").'
    ),
  viewerScope: z
    .enum(AGENT_SESSION_VIEWER_SCOPE_OPTIONS)
    .optional()
    .describe(
      'Aggregation scope: "self" (your own sessions), "organization" (all org sessions), or "team". Defaults to the widest scope you are authorized for.'
    ),
  teamId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Team id (UUID) to aggregate over. Required when viewerScope is "team"; must be omitted for any other scope.'
    ),
} as const;

type AgentSessionReportingInput = {
  startDate?: string;
  endDate?: string;
  harness?: string;
  viewerScope?: (typeof AGENT_SESSION_VIEWER_SCOPE_OPTIONS)[number];
  teamId?: string;
};

/**
 * Build the API query from the reporting tool inputs, dropping undefined
 * filters. Exported for unit testing the filter mapping.
 */
export function buildAgentSessionReportingQuery(
  input: AgentSessionReportingInput
): Record<string, string> {
  return buildQuery({
    startDate: input.startDate,
    endDate: input.endDate,
    harness: input.harness,
    viewerScope: input.viewerScope,
    teamId: input.teamId,
  });
}

export function registerGetAgentSessionUsage(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-agent-session-usage",
    {
      description:
        "Get aggregated agent-session usage for the organization: total sessions, token counts, estimated cost (subscription vs. API), and breakdowns by user, model, harness, and repository. Read-only reporting. Note: the API additionally requires agent-session monitoring to be enabled for your account; without it this tool returns a 403 (this is a permissions gate, not a bug).",
      inputSchema: agentSessionReportingInputSchema,
    },
    (input) =>
      withErrorHandling(async () => {
        const query = buildAgentSessionReportingQuery(input);
        const summary = await apiClient.get<AgentSessionUsageSummary>(
          "/agent-sessions/usage",
          query
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          ],
        };
      })
  );
}

export function registerGetAgentSessionAnalytics(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-agent-session-analytics",
    {
      description:
        "Get agent-session analytics for the organization: breakdowns by tool, agent type, repository, and project. Read-only reporting. Note: the API additionally requires agent-session monitoring to be enabled for your account; without it this tool returns a 403 (this is a permissions gate, not a bug).",
      inputSchema: agentSessionReportingInputSchema,
    },
    (input) =>
      withErrorHandling(async () => {
        const query = buildAgentSessionReportingQuery(input);
        const analytics = await apiClient.get<AgentSessionAnalytics>(
          "/agent-sessions/analytics",
          query
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(analytics, null, 2) },
          ],
        };
      })
  );
}
