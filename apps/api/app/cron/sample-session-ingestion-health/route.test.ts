import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sampleSessionIngestionHealth: vi.fn(),
  sampleSessionFleetCounts: vi.fn(),
  notifySlack: vi.fn(),
  buildCorrelationId: vi.fn(),
}));

vi.mock("./service", () => ({
  sampleSessionIngestionHealth: mocks.sampleSessionIngestionHealth,
}));

vi.mock("./service/fleet-counts", () => ({
  sampleSessionFleetCounts: mocks.sampleSessionFleetCounts,
}));

vi.mock("@/lib/slack-notifier", () => ({
  notifySlack: mocks.notifySlack,
  buildCorrelationId: mocks.buildCorrelationId,
}));

// route-utils schedules a real `waitUntil`/flush; stub the schedulers so the
// route under test does not touch process-level flush timers.
vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
  scheduleLogFlushAfter: vi.fn(),
}));

import { GET } from "./route";

const CRON_SECRET = "test-cron-secret";
const SLACK_ROUTE = "sample-session-ingestion-health";
const SLACK_ALERT_TITLE = "Session ingestion health check failure";
const FLEET_SLACK_ALERT_TITLE = "Session fleet count failure";
const CORRELATION_ID = "corr-123";

const HEALTH_SUMMARY = {
  orgsWithIngestHistory: 7,
  activeOrgCount: 5,
  stalledOrgCount: 2,
  quietOrgCount: 3,
  dormantOrgCount: 1,
  neverIngestedTargetCount: 3,
  stalenessSamplesEmitted: 4,
};

function authorizedRequest(): Request {
  return new Request("https://api.test/cron/sample-session-ingestion-health", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

let previousCronSecret: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
  mocks.buildCorrelationId.mockReturnValue(CORRELATION_ID);
  mocks.notifySlack.mockResolvedValue(undefined);
  mocks.sampleSessionFleetCounts.mockResolvedValue({
    totalSessionCount: 2,
    totalOrgCount: 2,
  });
});

afterEach(() => {
  if (previousCronSecret === undefined) {
    Reflect.deleteProperty(process.env, "CRON_SECRET");
  } else {
    process.env.CRON_SECRET = previousCronSecret;
  }
});

describe("GET /cron/sample-session-ingestion-health", () => {
  it("rejects a request without a valid CRON_SECRET bearer token (401) and never samples", async () => {
    const request = new Request(
      "https://api.test/cron/sample-session-ingestion-health",
      { headers: { authorization: "Bearer wrong-secret" } }
    );

    const response = await GET(request);

    expect(response.status).toBe(401);
    expect(mocks.sampleSessionIngestionHealth).not.toHaveBeenCalled();
    expect(mocks.notifySlack).not.toHaveBeenCalled();
  });

  it("runs the sampler and returns a 200 summary on success", async () => {
    mocks.sampleSessionIngestionHealth.mockResolvedValue(HEALTH_SUMMARY);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mocks.sampleSessionIngestionHealth).toHaveBeenCalledTimes(1);
    const body = await response.text();
    expect(body).toContain(`orgs=${HEALTH_SUMMARY.orgsWithIngestHistory}`);
    expect(body).toContain(`active=${HEALTH_SUMMARY.activeOrgCount}`);
    expect(body).toContain(`stalled=${HEALTH_SUMMARY.stalledOrgCount}`);
    expect(body).toContain(`quiet=${HEALTH_SUMMARY.quietOrgCount}`);
    expect(body).toContain(`dormant=${HEALTH_SUMMARY.dormantOrgCount}`);
    expect(body).toContain(
      `neverIngestedTargets=${HEALTH_SUMMARY.neverIngestedTargetCount}`
    );
    expect(body).toContain(`samples=${HEALTH_SUMMARY.stalenessSamplesEmitted}`);
    expect(mocks.sampleSessionFleetCounts).toHaveBeenCalledTimes(1);
    expect(mocks.notifySlack).not.toHaveBeenCalled();
  });

  it("keeps a 200 and alerts under the fleet title when only the fleet count fails", async () => {
    mocks.sampleSessionIngestionHealth.mockResolvedValue(HEALTH_SUMMARY);
    const failure = new Error("count timed out");
    mocks.sampleSessionFleetCounts.mockRejectedValue(failure);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(mocks.notifySlack).toHaveBeenCalledTimes(1);
    expect(mocks.notifySlack).toHaveBeenCalledWith({
      route: SLACK_ROUTE,
      title: FLEET_SLACK_ALERT_TITLE,
      message: `Session fleet count sampling failed: ${failure.message}`,
      correlationId: CORRELATION_ID,
    });
  });

  it("turns a sampler failure into a 500 and posts the titled Slack alert", async () => {
    const failure = new Error("groupBy exploded");
    mocks.sampleSessionIngestionHealth.mockRejectedValue(failure);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(500);
    expect(mocks.sampleSessionFleetCounts).toHaveBeenCalledTimes(1);
    expect(mocks.notifySlack.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sampleSessionFleetCounts.mock.invocationCallOrder[0]
    );
    expect(mocks.notifySlack).toHaveBeenCalledTimes(1);
    expect(mocks.notifySlack).toHaveBeenCalledWith({
      route: SLACK_ROUTE,
      title: SLACK_ALERT_TITLE,
      message: `Session ingestion health sampling failed: ${failure.message}`,
      correlationId: CORRELATION_ID,
    });
  });
});
