import type { ActivitySegment } from "@repo/api/src/types/agent-session";

/**
 * A zeroed {@link ActivitySegment} with only the fields a case cares about
 * overridden. Shared by the Activity breakdown suites — the main panel suite and
 * the ISS-5000 cost-reconciliation suite it was split from when that file
 * reached the 1,000-line ceiling — so the two cannot drift on what an
 * "empty" segment is.
 */
export function activitySegmentFixture(
  overrides: Partial<ActivitySegment> & { key: string }
): ActivitySegment {
  return {
    label: overrides.key,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 0,
    confidence: null,
    source: null,
    ...overrides,
  };
}
