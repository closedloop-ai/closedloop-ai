import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics";
import { UNCOMPUTED_SESSION_LAST_ACTIVITY_MS } from "@repo/lib/branches/branch-last-active";
import { describe, expect, it } from "vitest";
import {
  cloudRow,
  orgMergedAdmissionForRows,
} from "@/__tests__/support/branches/branch-canonical-metric-projection.test-helpers";
import {
  projectCloudCanonicalLastActive,
  projectCloudCanonicalMetrics,
} from "./branch-canonical-metric-projection";

const ATOM_AT = "2026-08-01T00:00:00.000Z";
const SESSION_AT = "2026-08-02T06:00:00.000Z";
const REQUEST_BOUNDARY = new Date("2026-08-03T00:00:00.000Z");

/**
 * ISS-11915: the cloud producer resolves Last active through the shared
 * definition (`resolveBranchLastActiveMetric`) Desktop uses, so a session-only
 * Branch reads its linked sessions' latest computed activity on both.
 */
describe("cloud Branch Last active through the shared definition", () => {
  it("reads a session-only Branch's Last active from its linked sessions", () => {
    const row = cloudRow("session-only", ATOM_AT, 1);
    row.branch.activityAtoms = [];
    Object.assign(row.branch, {
      linkedSessionActivityAt: new Date(SESSION_AT),
    });

    expect(projectCloudCanonicalLastActive(row)).toMatchObject({
      state: BranchMetricAvailability.Partial,
      value: SESSION_AT,
    });
    expect(
      projectCloudCanonicalMetrics(
        [row],
        {},
        REQUEST_BOUNDARY,
        orgMergedAdmissionForRows(row)
      ).lastActiveAt.value
    ).toBe(SESSION_AT);
  });

  it("keeps the atom over a newer linked session", () => {
    const row = cloudRow("atom", ATOM_AT, 1);
    Object.assign(row.branch, {
      linkedSessionActivityAt: new Date(SESSION_AT),
    });

    expect(projectCloudCanonicalLastActive(row).value).toBe(ATOM_AT);
  });

  it("treats the uncomputed epoch session default as no activity", () => {
    const row = cloudRow("epoch", ATOM_AT, 1);
    row.branch.activityAtoms = [];
    Object.assign(row.branch, {
      linkedSessionActivityAt: new Date(UNCOMPUTED_SESSION_LAST_ACTIVITY_MS),
    });

    expect(projectCloudCanonicalLastActive(row)).toEqual({
      state: BranchMetricAvailability.Unavailable,
      value: null,
    });
  });
});
