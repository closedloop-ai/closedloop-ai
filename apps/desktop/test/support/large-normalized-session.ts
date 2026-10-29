/**
 * A `NormalizedSession` heavy enough to exercise the importer's chunked
 * multi-row INSERT path (each batched category contributes `perCategory`
 * event rows, plus `perCategory` token_events rows), shared by the suites
 * that need a real, slow `importSession` rather than a one-turn fixture.
 */
import {
  emptyUsageExtras,
  type NormalizedSession,
} from "../../src/main/collectors/types.js";

const ISO_BASE = Date.parse("2026-06-07T10:00:00.000Z");

/** Distinct ISO timestamp `offsetSeconds` after the base — keeps every event
 * row's deterministic id unique so none collapse under dedup. */
function ts(offsetSeconds: number): string {
  return new Date(ISO_BASE + offsetSeconds * 1000).toISOString();
}

/**
 * Batched event categories `makeLargeNormalizedSession` fills; the import
 * writes `perCategory` event rows for each.
 */
export const LARGE_SESSION_EVENT_CATEGORIES = 6;

/**
 * Build a session whose import emits `perCategory` events in EACH of the
 * batched categories (messageTimestamps, toolUses, turnDurations, apiErrors,
 * toolResultErrors, compactions) plus `perCategory` token_events. With
 * perCategory = 1000 this is 6000+ event rows and 1000 token_events rows — far
 * more than a single chunk (chunk cap is ~112 event rows / ~128 token rows),
 * so the chunk-boundary path is exercised.
 */
export function makeLargeNormalizedSession(
  perCategory: number,
  sessionId = "batch-insert-session"
): NormalizedSession {
  let t = 0;
  const next = () => ts(t++);

  const messageTimestamps = Array.from({ length: perCategory }, () => next());
  const toolUses = Array.from({ length: perCategory }, (_, i) => ({
    name: "Bash",
    timestamp: next(),
    input: { command: `echo ${i}` },
    // distinct id so same-tool events never collapse in the dedup key
    id: `toolu_${i}`,
  }));
  const turnDurations = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    durationMs: 100 + i,
  }));
  const apiErrors = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    message: `api error ${i}`,
    type: "overloaded",
  }));
  const toolResultErrors = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    content: `tool result error ${i}`,
  }));
  const compactions = Array.from({ length: perCategory }, (_, i) => ({
    uuid: `compaction-${i}`,
    timestamp: next(),
  }));
  const tokenSeries = Array.from({ length: perCategory }, (_, i) => ({
    timestamp: next(),
    model: "claude-sonnet-4-5",
    input: 10 + i,
    output: 5 + i,
    cacheRead: i,
    cacheWrite: i,
  }));

  return {
    sessionId,
    name: "Batch insert session",
    cwd: "/workspace/test",
    model: "claude-sonnet-4-5",
    version: "1.0.0",
    slug: null,
    gitBranch: "main",
    startedAt: ts(0),
    endedAt: ts(t + 10),
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      "claude-sonnet-4-5": {
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
    },
    messageTimestamps,
    toolUses: toolUses as NormalizedSession["toolUses"],
    compactions: compactions as NormalizedSession["compactions"],
    apiErrors: apiErrors as NormalizedSession["apiErrors"],
    fileModifiedAt: null,
    turnDurations: turnDurations as NormalizedSession["turnDurations"],
    entrypoint: "claude",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: toolResultErrors as NormalizedSession["toolResultErrors"],
    // The canonical empty literal, not a hand-rolled one: FEA-3527 dropped
    // `cache_creation` from `usageExtras` and added two required counters, and a
    // re-spelled fixture silently describes a shape no parser emits.
    usageExtras: emptyUsageExtras(),
    messages: [],
    skills: [],
    hooks: [],
    tokenSeries,
    diffStats: null,
    slashCommands: [],
    artifacts: { prs: [], issues: [], repo: null },
    prLinks: [],
  };
}
