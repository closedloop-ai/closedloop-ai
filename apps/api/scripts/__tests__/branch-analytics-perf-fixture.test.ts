import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  getBranchCandidateSnapshots: vi.fn(),
  projectBranchListRows: vi.fn(),
  getBranchAnalyticsRows: vi.fn(),
  getBranchRowsById: vi.fn(),
  getBranchServerAnalyticsRows: vi.fn(),
  selectBranchServerRows: vi.fn(),
  toBranchServerPageQuery: vi.fn(),
  apiKeysGenerate: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return { ...actual, withDb: mocks.withDb };
});

vi.mock("@repo/lib/branches/branch-list-page", () => ({
  selectBranchServerRows: mocks.selectBranchServerRows,
}));

vi.mock("@/app/branches/branch-candidate-read", () => ({
  getBranchCandidateSnapshots: mocks.getBranchCandidateSnapshots,
}));

vi.mock("@/app/branches/branch-list-projection", () => ({
  projectBranchListRows: mocks.projectBranchListRows,
}));

vi.mock("@/app/branches/branch-read-service/persisted-row-read", () => ({
  getBranchAnalyticsRows: mocks.getBranchAnalyticsRows,
  getBranchRowsById: mocks.getBranchRowsById,
}));

vi.mock("@/app/branches/branch-server-analytics-cohort", () => ({
  getBranchServerAnalyticsRows: mocks.getBranchServerAnalyticsRows,
}));

vi.mock("@/app/branches/branch-server-page-query", () => ({
  toBranchServerPageQuery: mocks.toBranchServerPageQuery,
}));

vi.mock("@/app/api-keys/service", () => ({
  apiKeysService: {
    generate: mocks.apiKeysGenerate,
  },
}));

import { runBranchAnalyticsPerfFixtureScript } from "../branch-analytics-perf-fixture";
import {
  BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID,
  BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME,
} from "../branch-analytics-perf-fixture-guards";

const FIXTURE_URL =
  "postgresql://postgres:postgres@localhost:5432/closedloop_ai";

describe("branch analytics perf fixture command boundary", () => {
  it("refuses a host-overridden cleanup URL before opening a database connection", async () => {
    const runWithDb = vi.fn(
      async (_callback: (db: unknown) => unknown): Promise<void> => undefined
    );

    await expect(
      runBranchAnalyticsPerfFixtureScript({
        argv: ["--cleanup"],
        env: {
          DATABASE_URL: `${FIXTURE_URL}?host=db.example.test`,
        },
        runWithDb,
      })
    ).rejects.toThrow("host connection option");

    expect(runWithDb).not.toHaveBeenCalled();
    expect(mocks.withDb).not.toHaveBeenCalled();
  });

  it("refuses cleanup before delete delegates when the organization sentinel mismatches", async () => {
    const db = fakeDb({
      clerkId: null,
      id: "org-1",
      name: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_NAME,
    });
    const runWithDb = vi.fn(
      async (callback: (db: unknown) => unknown): Promise<void> => {
        await callback(db);
      }
    );

    await expect(
      runBranchAnalyticsPerfFixtureScript({
        argv: ["--cleanup"],
        env: { DATABASE_URL: FIXTURE_URL },
        runWithDb,
      })
    ).rejects.toThrow("does not carry the Branch analytics fixture sentinel");

    expect(runWithDb).toHaveBeenCalledTimes(1);
    expect(db.organization.findUnique).toHaveBeenCalled();
    expect(db.artifact.findMany).not.toHaveBeenCalled();
    expect(db.branchFileChange.deleteMany).not.toHaveBeenCalled();
    expect(db.branchActivityAtom.deleteMany).not.toHaveBeenCalled();
    expect(db.agentSessionActivitySegment.deleteMany).not.toHaveBeenCalled();
    expect(db.agentSessionTokenEvent.deleteMany).not.toHaveBeenCalled();
    expect(db.artifactLink.deleteMany).not.toHaveBeenCalled();
    expect(db.sessionDetail.deleteMany).not.toHaveBeenCalled();
    expect(db.branchDetail.deleteMany).not.toHaveBeenCalled();
    expect(db.artifact.deleteMany).not.toHaveBeenCalled();
    expect(db.apiKey.deleteMany).not.toHaveBeenCalled();
    expect(db.publicRepository.deleteMany).not.toHaveBeenCalled();
    expect(db.project.deleteMany).not.toHaveBeenCalled();
    expect(db.computeTarget.deleteMany).not.toHaveBeenCalled();
    expect(db.user.deleteMany).not.toHaveBeenCalled();
    expect(db.organization.delete).not.toHaveBeenCalled();
  });

  it("refuses cleanup when the organization name does not match the fixture sentinel", async () => {
    const db = fakeDb({
      clerkId: BRANCH_ANALYTICS_PERF_FIXTURE_ORGANIZATION_CLERK_ID,
      id: "org-1",
      name: "Some Other Org",
    });
    const runWithDb = vi.fn(
      async (callback: (db: unknown) => unknown): Promise<void> => {
        await callback(db);
      }
    );

    await expect(
      runBranchAnalyticsPerfFixtureScript({
        argv: ["--cleanup"],
        env: { DATABASE_URL: FIXTURE_URL },
        runWithDb,
      })
    ).rejects.toThrow("does not carry the Branch analytics fixture sentinel");

    expect(db.organization.delete).not.toHaveBeenCalled();
  });
});

function fakeDb(organization: {
  clerkId: string | null;
  id: string;
  name: string;
}) {
  return {
    organization: {
      findUnique: vi.fn().mockResolvedValue(organization),
      delete: vi.fn(),
    },
    artifact: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    },
    apiKey: { deleteMany: vi.fn() },
    branchFileChange: { deleteMany: vi.fn() },
    branchActivityAtom: { deleteMany: vi.fn() },
    agentSessionActivitySegment: { deleteMany: vi.fn() },
    agentSessionTokenEvent: { deleteMany: vi.fn() },
    artifactLink: { deleteMany: vi.fn() },
    sessionDetail: { deleteMany: vi.fn() },
    branchDetail: { deleteMany: vi.fn() },
    publicRepository: { deleteMany: vi.fn() },
    project: { deleteMany: vi.fn() },
    computeTarget: { deleteMany: vi.fn() },
    user: { deleteMany: vi.fn() },
  };
}
