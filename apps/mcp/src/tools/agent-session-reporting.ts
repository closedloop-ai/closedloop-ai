import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SESSION_QUALITY_VALUES } from "@repo/api/src/agent-session-filters.js";
import {
  AGENT_SESSION_VIEWER_SCOPE_OPTIONS,
  type AgentSessionAnalytics,
  type AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { buildQuery, withErrorHandling } from "./tool-utils.js";

/**
 * Non-date optional filters shared by both read-only agent-session reporting
 * tools. These are a curated subset of the query params accepted by the
 * `/agent-sessions/usage` and `/agent-sessions/analytics` routes
 * (`baseAgentSessionQuerySchema`); the routes accept additional filters — e.g.
 * `repositories`, `projectId`, and the multi-select facets — that these tools
 * intentionally do not expose. Every param mapped here is forwarded unchanged,
 * and the API validates values and enforces org/team/self viewer scoping
 * server-side.
 *
 * The `startDate`/`endDate` window is NOT shared: the two routes window on
 * different timestamps, so each tool supplies its own date `.describe()` copy
 * (see `buildAgentSessionReportingInputSchema`). `/agent-sessions/usage` windows
 * on `lastActivityAt` (FEA-4298/ISS-4429 — one cohort with the Sessions table),
 * while `/agent-sessions/analytics` still windows on `sessionStartedAt`
 * (`buildWhere`'s default), so a single "started" or "active" description cannot
 * be truthful for both (thread wongk).
 */
const agentSessionReportingSharedFilters = {
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
  quality: z
    .enum(SESSION_QUALITY_VALUES)
    .optional()
    .describe(
      'Session-quality filter (FEA-3284). Defaults to "substantive", which excludes idle sessions (0 turns, 0 tokens, and 0 tool uses) from the aggregates; pass "all" to include them, or "idle" to aggregate only idle sessions.'
    ),
} as const;

/**
 * The usage summary windows on `lastActivityAt` (FEA-4298/ISS-4429), so its date
 * params describe an ACTIVITY window — a session that started before the window
 * but was active inside it is included, exactly as the Sessions table paints it.
 */
const usageStartDateDescription =
  "Only include sessions last active on or after this ISO 8601 date or timestamp (e.g. 2026-07-01). This is an activity window on lastActivityAt, not a session start-date filter, so a session that started earlier but was active in the window is included.";
const usageEndDateDescription =
  "Only include sessions last active on or before this ISO 8601 date or timestamp (e.g. 2026-07-31). This is an activity window on lastActivityAt, not a session start-date filter.";

/**
 * The analytics route windows on `sessionStartedAt` (`buildWhere`'s default), so
 * its date params describe a session START window.
 */
const analyticsStartDateDescription =
  "Only include sessions started on or after this ISO 8601 date or timestamp (e.g. 2026-07-01). This is a session start-date window on sessionStartedAt.";
const analyticsEndDateDescription =
  "Only include sessions started on or before this ISO 8601 date or timestamp (e.g. 2026-07-31). This is a session start-date window on sessionStartedAt.";

/**
 * Build the full input schema for a reporting tool: the shared non-date filters
 * plus a `startDate`/`endDate` window whose descriptions match the timestamp the
 * backing route actually windows on. Keeps the two tools' shared facets in one
 * place while letting each describe its own (divergent) date semantics.
 */
function buildAgentSessionReportingInputSchema(
  startDateDescription: string,
  endDateDescription: string
) {
  return {
    startDate: z.string().optional().describe(startDateDescription),
    endDate: z.string().optional().describe(endDateDescription),
    ...agentSessionReportingSharedFilters,
  } as const;
}

type AgentSessionReportingInput = {
  startDate?: string;
  endDate?: string;
  harness?: string;
  viewerScope?: (typeof AGENT_SESSION_VIEWER_SCOPE_OPTIONS)[number];
  teamId?: string;
  quality?: (typeof SESSION_QUALITY_VALUES)[number];
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
    // FEA-3345: the server default is now fail-open `all`. This MCP reporting
    // tool keeps its documented `substantive` default (exclude idle sessions from
    // the aggregates) by sending it explicitly when the agent omits `quality`, so
    // the `.describe()` contract above stays truthful and headline
    // counts/tokens don't silently start including idle rows.
    quality: input.quality ?? "substantive",
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
      inputSchema: buildAgentSessionReportingInputSchema(
        usageStartDateDescription,
        usageEndDateDescription
      ),
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
      inputSchema: buildAgentSessionReportingInputSchema(
        analyticsStartDateDescription,
        analyticsEndDateDescription
      ),
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
