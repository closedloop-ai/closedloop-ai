import type { SyncedActivitySegmentRow } from "@repo/api/src/types/agent-session";

/**
 * A complete {@link SyncedActivitySegmentRow} for activity-segment tests.
 *
 * Shared rather than re-declared per suite: the aggregation's own behaviour
 * turns on fields a caller rarely names (`evidenceLayers` decides a phase's
 * provenance, `confidence` its weighted mean), so a per-file builder that
 * spells only the fields its own assertions touch silently changes what the
 * function under test is being handed.
 */
export function activitySegmentRow(
  overrides: Partial<SyncedActivitySegmentRow> & {
    phase: string;
    startMs: number;
    endMs: number;
  }
): SyncedActivitySegmentRow {
  return {
    confidence: 0.9,
    evidenceLayers: ["structural"],
    version: 1,
    workItemRef: null,
    subagentId: null,
    ...overrides,
  };
}
