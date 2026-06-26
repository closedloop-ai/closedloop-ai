// Shared test fixtures for LocalJob / JobStore. Centralized so tests reuse one
// canonical job shape and one stub-store cast rather than hand-rolling 30-field
// LocalJob literals (which drift silently when the type changes).

import type { JobStore, LocalJob } from "../src/main/job-store.js";

/**
 * Builds a minimal valid `LocalJob` with sensible defaults; pass `overrides`
 * to customize any field. Defaults to a RUNNING SYMPHONY_LOOP PLAN job with
 * id/loopId "loop-1".
 */
export function createLocalJob(overrides?: Partial<LocalJob>): LocalJob {
  const now = new Date().toISOString();
  return {
    id: "loop-1",
    kind: "SYMPHONY_LOOP",
    loopId: "loop-1",
    command: "PLAN",
    status: "RUNNING",
    startedAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Returns a stub `JobStore` whose `getByLoopId` resolves the jobs in
 * `jobsByLoopId` (keyed by loopId) and returns undefined for anything else.
 * Other methods are inert. Centralizes the `as unknown as JobStore` cast so it
 * lives in exactly one place across the test suite.
 */
export function makeStubJobStore(
  jobsByLoopId: Record<string, LocalJob> = {}
): JobStore {
  return {
    getByLoopId: (loopId: string) => jobsByLoopId[loopId],
  } as unknown as JobStore;
}
