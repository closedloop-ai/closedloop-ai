import { ArtifactType } from "@repo/api/src/types/artifact";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditResults } from "./service";

const {
  mockValidateCronSecret,
  mockAuditDataInvariants,
  mockScheduleLogFlush,
  mockScheduleLogFlushAfter,
  mockNotifySlack,
  mockBuildCorrelationId,
  mockLogInfo,
  mockLogError,
} = vi.hoisted(() => ({
  mockValidateCronSecret: vi.fn(),
  mockAuditDataInvariants: vi.fn(),
  mockScheduleLogFlush: vi.fn(),
  mockScheduleLogFlushAfter: vi.fn(),
  mockNotifySlack: vi.fn(),
  mockBuildCorrelationId: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock("@/lib/auth/cron-secret", () => ({
  validateCronSecret: mockValidateCronSecret,
}));
vi.mock("./service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service")>()),
  auditDataInvariants: mockAuditDataInvariants,
}));
vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: mockScheduleLogFlush,
  scheduleLogFlushAfter: mockScheduleLogFlushAfter,
}));
vi.mock("@/lib/slack-notifier", () => ({
  notifySlack: mockNotifySlack,
  buildCorrelationId: mockBuildCorrelationId,
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: mockLogInfo, error: mockLogError },
}));
vi.mock("@repo/observability/error", () => ({
  parseError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { GET, maxDuration } from "./route";

const cleanResults: AuditResults = {
  zeroCostSessions: { count: 0, sampleIds: [] },
  zeroCostBranches: { count: 0, sampleIds: [] },
  unbranchedPrs: { count: 0, sampleIds: [] },
  linesFilesMismatch: { count: 0, sampleIds: [] },
  zeroEstimateWithReportedCost: { count: 0, sampleIds: [] },
  crossOrgProjectAssignees: { count: 0, sampleIds: [] },
  dualLedgerBranches: 0,
  costEstimateDivergence: 0,
  enrichmentPendingSessions: 42,
  enrichmentPendingPrs: 7,
  unpricedTokenSessions: { count: 0, byModel: [] },
  offVocabularyArtifactStatuses: { count: 0, byStatus: [] },
  integrationTokenEncryption: {
    unencrypted: 0,
    byOwner: [],
  },
  totalViolations: 0,
};

const violationResults: AuditResults = {
  zeroCostSessions: { count: 3, sampleIds: ["s1", "s2", "s3"] },
  zeroCostBranches: { count: 1, sampleIds: ["b1"] },
  unbranchedPrs: { count: 0, sampleIds: [] },
  linesFilesMismatch: { count: 2, sampleIds: ["p1", "p2"] },
  zeroEstimateWithReportedCost: { count: 4, sampleIds: ["z1"] },
  crossOrgProjectAssignees: { count: 0, sampleIds: [] },
  dualLedgerBranches: 5,
  costEstimateDivergence: 9,
  enrichmentPendingSessions: 100,
  enrichmentPendingPrs: 20,
  unpricedTokenSessions: { count: 6, byModel: [] },
  offVocabularyArtifactStatuses: { count: 0, byStatus: [] },
  integrationTokenEncryption: {
    unencrypted: 0,
    byOwner: [],
  },
  totalViolations: 10,
};

describe("audit-data-invariants cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateCronSecret.mockReturnValue(null);
    mockAuditDataInvariants.mockResolvedValue(cleanResults);
    mockNotifySlack.mockResolvedValue(undefined);
    mockBuildCorrelationId.mockReturnValue("corr-123");
  });

  it("denies unauthenticated requests before any work", async () => {
    mockValidateCronSecret.mockReturnValue(
      new Response("unauthorized", { status: 401 })
    );

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(401);
    expect(mockAuditDataInvariants).not.toHaveBeenCalled();
  });

  it("exports maxDuration = 300", () => {
    expect(maxDuration).toBe(300);
  });

  it("returns 200 with summary on clean audit", async () => {
    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("zeroCostSessions=0");
    expect(body).toContain("totalViolations=0");
    expect(mockScheduleLogFlush).toHaveBeenCalledTimes(1);
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("notifies Slack when violations are found", async () => {
    mockAuditDataInvariants.mockResolvedValue(violationResults);

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(200);
    expect(mockNotifySlack).toHaveBeenCalledTimes(1);
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "audit-data-invariants",
        title: "Data invariant violations detected",
        correlationId: "corr-123",
      })
    );
    const slackMessage = mockNotifySlack.mock.calls[0][0].message;
    expect(slackMessage).toContain("zeroCostSessions=3");
    expect(slackMessage).toContain("linesFilesMismatch=2");
    expect(slackMessage).toContain("zeroEstimateWithReportedCost=4");
    // Gauges stay out of the alert even when non-zero.
    expect(slackMessage).not.toContain("costEstimateDivergence");
    expect(slackMessage).not.toContain("dualLedgerBranches");
  });

  it("does not notify Slack for gauge-only checks (5, 6) even when non-zero", async () => {
    const gaugeOnlyResults: AuditResults = {
      ...cleanResults,
      dualLedgerBranches: 10,
      costEstimateDivergence: 25,
      enrichmentPendingSessions: 500,
      enrichmentPendingPrs: 50,
      // ISS-8515: gauge 9 is non-paging too — a non-zero value here must not
      // reach Slack, which is the whole reason it is absent from
      // VIOLATION_CHECK_KEYS.
      unpricedTokenSessions: {
        count: 12,
        byModel: [{ model: "claude-opus-5", sessionCount: 12 }],
      },
      // ISS-9434: gauge 10 is non-paging for the same reason — its steady state
      // is unmeasured across orgs and a live legacy `waiting` population is
      // deliberately still in place, so a threshold alert would fire daily.
      offVocabularyArtifactStatuses: {
        count: 4,
        byStatus: [
          {
            type: ArtifactType.Document,
            subtype: DocumentType.Feature,
            status: DocumentStatus.Obsolete,
            artifactCount: 4,
          },
        ],
      },
    };
    mockAuditDataInvariants.mockResolvedValue(gaugeOnlyResults);

    const response = await GET(new Request("http://localhost/cron"));

    expect(mockNotifySlack).not.toHaveBeenCalled();
    // Reported in the response summary even though it never pages.
    await expect(response.text()).resolves.toContain(
      "offVocabularyArtifactStatuses=4"
    );
  });

  it("returns 500 and notifies Slack on service error", async () => {
    mockAuditDataInvariants.mockRejectedValue(new Error("db timeout"));

    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });

  it("calls service before scheduleLogFlush", async () => {
    const response = await GET(new Request("http://localhost/cron"));

    expect(response.status).toBe(200);
    expect(mockAuditDataInvariants.mock.invocationCallOrder[0]).toBeLessThan(
      mockScheduleLogFlush.mock.invocationCallOrder[0]
    );
  });
});
