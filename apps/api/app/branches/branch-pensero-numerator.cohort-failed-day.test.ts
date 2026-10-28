import {
  BranchMetricAvailability,
  BranchMetricDisclosure,
} from "@repo/api/src/types/branch-metrics";
import { Prisma, withDb } from "@repo/database";
import { calculateDetailPenseroPointsPerDollar } from "@repo/lib/branches/branch-detail-pensero-points";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failedPenseroDayFindFirst } from "@/__tests__/support/branches/pensero-failed-day-ledger.test-fixtures";
import {
  attributeDeliveryPoints,
  type DeliveryPointWindow,
} from "@/lib/delivery-points/delivery-point-attribution";
import type { PenseroDateWindowQuery } from "@/lib/delivery-points/delivery-point-window";
import { cohortPenseroReaderForRequest } from "./branch-pensero-window";

const mocks = vi.hoisted(() => ({
  isFeatureFlagEnabledForAnyIdentity: vi.fn(),
  readPenseroBranchDeliveryPoints: vi.fn(),
}));

vi.mock("@/lib/feature-flag-identity", () => ({
  isFeatureFlagEnabledForAnyIdentity: mocks.isFeatureFlagEnabledForAnyIdentity,
}));

vi.mock("@/lib/delivery-points/delivery-point-read", () => ({
  readPenseroBranchDeliveryPoints: mocks.readPenseroBranchDeliveryPoints,
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: vi.fn() };
});

const IDENTITY = { userId: "user-1", clerkUserId: "clerk-1" };
const ORG = "org-1";
const BRANCH = "branch-artifact-1";
/** The org's one day it attempted and never retrieved. */
const FAILED_DAY = new Date("2026-06-12T00:00:00.000Z");
const COST = { state: BranchMetricAvailability.Complete, value: 1 } as const;

/**
 * ISS-11600, Perrin Upcott's ruling 2026-09-29: the Branches listing's cohort
 * card names the failed day only when it falls inside the request's window.
 *
 * Two requests against ONE ledger, because a single request cannot tell a
 * window-bounded probe from the org-wide one. Both go through the real reader
 * binding, the real ledger predicate and the real disclosure kernel.
 */
describe("readCohortPenseroNumerator — ISS-11600 failed-day disclosure window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isFeatureFlagEnabledForAnyIdentity.mockResolvedValue(true);
    mocks.readPenseroBranchDeliveryPoints.mockImplementation(
      (
        _identity: unknown,
        _organizationId: string,
        branchArtifactIds: readonly string[],
        window?: DeliveryPointWindow
      ) =>
        Promise.resolve(
          attributeDeliveryPoints(
            [
              {
                id: "share-1",
                points: new Prisma.Decimal("20"),
                branchArtifactId: BRANCH,
                providerInteractionId: "interaction-1",
                deliveredOn: new Date("2026-06-18T00:00:00.000Z"),
              },
            ],
            branchArtifactIds,
            window
          )
        )
    );
    const db = {
      penseroBackfillDay: {
        findFirst: vi.fn(failedPenseroDayFindFirst(ORG, FAILED_DAY)),
      },
    };
    vi.mocked(withDb).mockImplementation((callback) =>
      Promise.resolve(callback(db as never))
    );
  });

  it("a window holding the failed day names it, one without does not; both publish", async () => {
    // Adjacent at the failed day's UTC boundary: the first window opens late
    // ON that day, the second at the next midnight.
    const holds = await cohortCard({
      startDate: "2026-06-12T18:00:00.000Z",
      endDate: "2026-06-20T23:59:59.999Z",
    });
    const misses = await cohortCard({
      startDate: "2026-06-13T00:00:00.000Z",
      endDate: "2026-06-20T23:59:59.999Z",
    });

    expect(holds).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 20,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionDaysFailed,
    });
    expect(misses).toEqual({
      state: BranchMetricAvailability.Partial,
      value: 20,
      disclosure: BranchMetricDisclosure.PenseroAcquisitionIncomplete,
    });
  });
});

async function cohortCard(query: PenseroDateWindowQuery) {
  const numerator = await cohortPenseroReaderForRequest(
    IDENTITY,
    ORG,
    query
  )([BRANCH]);
  return calculateDetailPenseroPointsPerDollar(numerator, COST);
}
