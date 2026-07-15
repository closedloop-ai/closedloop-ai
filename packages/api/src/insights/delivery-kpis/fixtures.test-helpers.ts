// FEA-2952 / PLN-1323 — shared test fixtures/builders for the delivery-KPI tests.
// Not a *.test.ts file so it is imported, not executed, by the runner.

import type {
  NormalizedBranch,
  NormalizedDeliveryRows,
  NormalizedPr,
  NormalizedSession,
} from "./normalized-rows.ts";
import {
  NormalizedBranchStatus,
  NormalizedPrState,
} from "./normalized-rows.ts";

/** A wide window that admits every fixture timestamp used in the tests. */
export const WIDE_WINDOW = { start: 0, end: 10_000 } as const;

const DEFAULT_PR: NormalizedPr = {
  state: NormalizedPrState.Merged,
  createdAt: 100,
  mergedAt: 200,
  closedAt: null,
  additions: 10,
  deletions: 5,
  enriched: true,
  observedAt: 200,
};

/** Builds a NormalizedPr, overriding only the fields a test cares about. */
export function makePr(overrides: Partial<NormalizedPr> = {}): NormalizedPr {
  return { ...DEFAULT_PR, ...overrides };
}

const DEFAULT_SESSION: NormalizedSession = {
  startedAt: 100,
  costUsd: 1,
  tokens: 1000,
};

export function makeSession(
  overrides: Partial<NormalizedSession> = {}
): NormalizedSession {
  return { ...DEFAULT_SESSION, ...overrides };
}

const DEFAULT_BRANCH: NormalizedBranch = {
  status: NormalizedBranchStatus.Merged,
  additions: 100,
  deletions: 50,
  startedAt: 100,
  settledAt: 200,
  hasPr: true,
};

export function makeBranch(
  overrides: Partial<NormalizedBranch> = {}
): NormalizedBranch {
  return { ...DEFAULT_BRANCH, ...overrides };
}

/** Assembles NormalizedDeliveryRows from parts, defaulting to WIDE_WINDOW. */
export function makeRows(
  parts: Partial<NormalizedDeliveryRows> = {}
): NormalizedDeliveryRows {
  return {
    prs: parts.prs ?? [],
    sessions: parts.sessions ?? [],
    branches: parts.branches ?? [],
    window: parts.window ?? { ...WIDE_WINDOW },
  };
}
