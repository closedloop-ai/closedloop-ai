import { BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES } from "@repo/api/src/types/branch-analytics-cohort";
import {
  BranchMetricAvailability,
  BranchMetricComparisonLabel,
  BranchMetricPeriod,
} from "@repo/api/src/types/branch-metrics";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BRANCH_ID = "019fd2bf-21b7-7699-92bd-727d4d29b068";
const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  getBranchCohortAnalytics: vi.fn(),
  withAnyAuthOptions: [] as unknown[],
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>, options: unknown) =>
    (request: NextRequest) => {
      mocks.withAnyAuthOptions.push(options);
      return handler(mocks.auth, request);
    },
}));

vi.mock("@/app/branches/branch-read-service", () => ({
  branchReadService: {
    getBranchCohortAnalytics: mocks.getBranchCohortAnalytics,
  },
}));

import { POST } from "./route";

describe("POST /branches/analytics/cohort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withAnyAuthOptions.length = 0;
    mocks.getBranchCohortAnalytics.mockResolvedValue(responseBody());
  });

  it("requires read scope and forwards the normalized org-scoped request", async () => {
    const response = await POST(
      request({ branchIds: [` ${BRANCH_ID} `] }),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(mocks.withAnyAuthOptions).toEqual([{ requiredScopes: ["read"] }]);
    expect(mocks.getBranchCohortAnalytics).toHaveBeenCalledWith("org-1", {
      branchIds: [BRANCH_ID],
    });
  });

  it("accepts an inclusive UTC-day cohort window", async () => {
    const body = {
      branchIds: [BRANCH_ID],
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-07T23:59:59.999Z",
    };

    const response = await POST(request(body), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.getBranchCohortAnalytics).toHaveBeenCalledWith("org-1", body);
  });

  it("forwards an exact 101-identity cohort", async () => {
    const branchIds = makeBranchIds(101);

    const response = await POST(request({ branchIds }), routeContext());

    expect(response.status).toBe(200);
    expect(mocks.getBranchCohortAnalytics).toHaveBeenCalledWith("org-1", {
      branchIds,
    });
  });

  it("rejects a body above 64 KiB before service work", async () => {
    const body = " ".repeat(BRANCH_ANALYTICS_COHORT_MAX_REQUEST_BYTES + 1);

    const response = await POST(rawRequest(body), routeContext());

    expect(response.status).toBe(413);
    expect(mocks.getBranchCohortAnalytics).not.toHaveBeenCalled();
  });

  it.each([
    { branchIds: [] },
    { branchIds: ["not-a-uuid"] },
    { branchIds: [BRANCH_ID], startDate: "2026-07-01T00:00:00.000Z" },
    { branchIds: [BRANCH_ID], unexpected: true },
  ])("rejects malformed payload before service work %#", async (body) => {
    const response = await POST(request(body), routeContext());

    expect(response.status).toBe(400);
    expect(mocks.getBranchCohortAnalytics).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return rawRequest(JSON.stringify(body));
}

function rawRequest(body: string) {
  return new NextRequest("https://api.example.test/branches/analytics/cohort", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

function makeBranchIds(length: number) {
  return Array.from(
    { length },
    (_, index) =>
      `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`
  );
}

function routeContext() {
  return { params: Promise.resolve({}) };
}

function responseBody() {
  const noData = {
    state: BranchMetricAvailability.NoData,
    value: null,
  } as const;
  const value = { current: noData };
  return {
    matchedBranchIds: [],
    canonicalMetrics: {
      period: BranchMetricPeriod.All,
      label: BranchMetricComparisonLabel.AllTime,
      window: { startAt: null, endAt: "2026-08-05T00:00:00.000Z" },
      cohortSize: 0,
      lastActiveAt: noData,
      activeBranches: value,
      locPerDollar: value,
      medianPrSize: value,
      aiSpendUsd: value,
      mergeRatePct: value,
    },
  };
}
