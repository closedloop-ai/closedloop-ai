import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  AGENT_SESSION_VIEWER_SCOPE_OPTIONS,
  type AgentSessionListResponse,
} from "@repo/api/src/types/agent-session.js";
import {
  TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS,
  type TranscriptAccessResponse,
} from "@repo/api/src/types/desktop-transcripts.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  asRecord,
  buildQuery,
  encodePathSegment,
  MAX_PAGE_LIMIT,
  readNumber,
  readString,
  withErrorHandling,
} from "./tool-utils.js";

/**
 * Read-only tools that expose the agent-session core entity over MCP so an
 * external agent (or the user's own tooling) can pull a completed run to
 * replay, audit, or learn from it (FEA-2885). Both call the `withAnyAuth`
 * `/agent-sessions` routes that already accept `sk_live_*` keys, and both are
 * gated on the same `emergent` flag + server-side monitoring permission as the
 * sibling reporting tools — without those the API returns a 403.
 */
const agentSessionListInputSchema = {
  startDate: z
    .string()
    .optional()
    .describe(
      "Only include sessions last active on or after this ISO 8601 date or timestamp (e.g. 2026-07-01). This is an activity window on lastActivityAt, not a session start-date filter, so a session that started earlier but was active in the window is included."
    ),
  endDate: z
    .string()
    .optional()
    .describe(
      "Only include sessions last active on or before this ISO 8601 date or timestamp (e.g. 2026-07-31). This is an activity window on lastActivityAt, not a session start-date filter."
    ),
  harness: z
    .string()
    .optional()
    .describe(
      'Filter to a single agent harness (e.g. "claude-code", "codex").'
    ),
  status: z
    .string()
    .optional()
    .describe(
      'Filter to a single canonical session status: "active", "waiting", "completed", "error", or "abandoned".'
    ),
  userId: z
    .string()
    .uuid()
    .optional()
    .describe("Filter to a single user's sessions by user id (UUID)."),
  viewerScope: z
    .enum(AGENT_SESSION_VIEWER_SCOPE_OPTIONS)
    .optional()
    .describe(
      'Visibility scope: "self" (your own sessions), "organization" (all org sessions), or "team". Defaults to the widest scope you are authorized for.'
    ),
  teamId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Team id (UUID) to scope to. Required when viewerScope is "team"; must be omitted for any other scope.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(`Maximum sessions to return (1-${MAX_PAGE_LIMIT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Starting offset for pagination (default 0)."),
} as const;

type AgentSessionListInput = {
  startDate?: string;
  endDate?: string;
  harness?: string;
  status?: string;
  userId?: string;
  viewerScope?: (typeof AGENT_SESSION_VIEWER_SCOPE_OPTIONS)[number];
  teamId?: string;
  limit?: number;
  offset?: number;
};

/**
 * Build the API query from the list-tool inputs, dropping undefined filters and
 * stringifying the numeric pagination params (the route coerces them back).
 * Exported for unit testing the filter mapping.
 */
export function buildAgentSessionListQuery(
  input: AgentSessionListInput
): Record<string, string> {
  return buildQuery({
    startDate: input.startDate,
    endDate: input.endDate,
    harness: input.harness,
    status: input.status,
    userId: input.userId,
    viewerScope: input.viewerScope,
    teamId: input.teamId,
    limit: input.limit === undefined ? undefined : String(input.limit),
    offset: input.offset === undefined ? undefined : String(input.offset),
  });
}

/**
 * Shape one API session row into a compact, stable projection for the
 * `list-agent-sessions` response. Keeps the identifiers a follow-up
 * `get-agent-session-transcript` call needs (the artifact `id`) plus the core
 * run metadata, without echoing the full ~50-field list item per row.
 */
export function shapeAgentSessionListItem(value: unknown) {
  const row = asRecord(value);
  const user = asRecord(row.user);
  return {
    // Artifact id — pass this to get-agent-session-transcript.
    id: readString(row.id),
    // SES-* slug (human-facing handle); the transcript route resolves the id.
    slug: readString(row.slug),
    externalSessionId: readString(row.externalSessionId),
    name: readString(row.name),
    status: readString(row.status),
    harness: readString(row.harness),
    model: readString(row.model),
    repositoryFullName: readString(row.repositoryFullName),
    baseBranch: readString(row.baseBranch),
    startedAt: readString(row.startedAt),
    lastActivityAt: readString(row.lastActivityAt),
    endedAt: readString(row.endedAt),
    estimatedCost: readNumber(row.estimatedCost),
    inputTokens: readNumber(row.inputTokens),
    outputTokens: readNumber(row.outputTokens),
    cacheReadTokens: readNumber(row.cacheReadTokens),
    cacheWriteTokens: readNumber(row.cacheWriteTokens),
    agentCount: readNumber(row.agentCount),
    toolUseCount: readNumber(row.toolUseCount),
    errorCount: readNumber(row.errorCount),
    sourceArtifactId: readString(row.sourceArtifactId),
    sourceLoopId: readString(row.sourceLoopId),
    user: row.user
      ? {
          id: readString(user.id),
          email: readString(user.email),
          firstName: readString(user.firstName),
          lastName: readString(user.lastName),
        }
      : null,
  };
}

export function registerListAgentSessions(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-agent-sessions",
    {
      description:
        "List agent sessions — Closedloop's core entity: one AI agent run, with its harness, model, repository, token usage, cost, and status. Read-only; server-side pagination (the API applies limit/offset and sorts by most recent activity). Use the returned `id` with get-agent-session-transcript to pull a run's transcript. Note: the API additionally requires agent-session monitoring to be enabled for your account; without it this tool returns a 403 (this is a permissions gate, not a bug).",
      inputSchema: agentSessionListInputSchema,
    },
    (input) =>
      withErrorHandling(async () => {
        const query = buildAgentSessionListQuery(input);
        const response = await apiClient.get<AgentSessionListResponse>(
          "/agent-sessions",
          query
        );
        const record = asRecord(response);
        const items = Array.isArray(record.items) ? record.items : [];
        const payload = {
          items: items.map(shapeAgentSessionListItem),
          returned: items.length,
          total: readNumber(record.total) ?? items.length,
          viewerScope: readString(record.viewerScope),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
        };
      })
  );
}

export function registerGetAgentSessionTranscript(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "get-agent-session-transcript",
    {
      description: `Get read access to an agent session's archived transcript files (the main run plus any subagent sidechain files). Returns one descriptor per file with its availability state and, when available, a short-lived signed S3 GET URL (expires in ~${Math.round(
        TRANSCRIPT_DOWNLOAD_URL_TTL_SECONDS / 60
      )} minutes) that you fetch directly to read the raw JSONL trajectory. Read-only. Note: the API additionally requires agent-session monitoring to be enabled for your account; without it this tool returns a 403 (this is a permissions gate, not a bug).`,
      inputSchema: {
        sessionId: z
          .string()
          .uuid()
          .describe(
            "Agent-session id — the `id` field (a UUID) returned by list-agent-sessions. The SES-* slug is not accepted here."
          ),
      },
    },
    ({ sessionId }) =>
      withErrorHandling(async () => {
        const access = await apiClient.get<TranscriptAccessResponse>(
          `/agent-sessions/${encodePathSegment(sessionId)}/transcript`
        );
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(access, null, 2) },
          ],
        };
      })
  );
}
