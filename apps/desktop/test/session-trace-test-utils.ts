import type { SessionTraceSyncInput } from "../src/main/database/session-trace.js";

// Shared session-trace fixture builder. Used by the branch-resolution and
// wall-clock-anchor suites (and any future session-trace test) so the
// SessionTraceSyncInput default shape lives in one place instead of being
// duplicated per file. `endedAt` defaults to null (an open session); ended-state
// tests pass an explicit `endedAt` override.
export function baseSessionTraceInput(
  overrides: Partial<SessionTraceSyncInput>
): SessionTraceSyncInput {
  return {
    startedAt: "2026-06-07T12:00:00.000Z",
    updatedAt: "2026-06-07T12:05:00.000Z",
    endedAt: null,
    metadata: null,
    attribution: null,
    artifactLinkBranch: null,
    events: [],
    timelineRows: [],
    tokenEvents: [],
    localPullRequests: [],
    ...overrides,
  };
}

export function traceTimelineRow(
  createdAt: string,
  eventType = "ToolUse"
): SessionTraceSyncInput["timelineRows"][number] {
  return {
    eventType,
    toolName: "bash",
    createdAt,
    label: "bash",
  };
}

export function traceTokenEvent(
  createdAt: string
): SessionTraceSyncInput["tokenEvents"][number] {
  return {
    model: "opus",
    created_at: createdAt,
    input_tokens: 10,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd_estimated: null,
    input_cost_usd_estimated: null,
    output_cost_usd_estimated: null,
    cache_read_cost_usd_estimated: null,
    cache_creation_cost_usd_estimated: null,
  };
}
