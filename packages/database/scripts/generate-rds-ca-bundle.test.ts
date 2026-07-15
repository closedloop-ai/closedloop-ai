import { afterEach, expect, test, vi } from "vitest";
import {
  classifyStatusError,
  getStatus,
  RdsCaBundleStatus,
  type RdsCaBundleStatusReport,
} from "./generate-rds-ca-bundle";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("RDS CA status contract includes drift and non-drift failure classifications", () => {
  const statuses = Object.values(RdsCaBundleStatus).sort();

  expect(statuses).toEqual([
    "drift",
    "fetch_failed",
    "invalid_bundle",
    "match",
    "unexpected_failure",
  ]);
});

test("RDS CA status report keeps drift metadata package-owned", () => {
  const report: RdsCaBundleStatusReport = {
    certificateCount: 108,
    embeddedSha256: "old-sha",
    message: "The AWS RDS CA bundle changed.",
    sourceUrl:
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
    status: RdsCaBundleStatus.Drift,
    upstreamSha256: "new-sha",
  };

  expect(report.status).toBe(RdsCaBundleStatus.Drift);
  expect(report.certificateCount).toBe(108);
  expect(report.upstreamSha256).toBe("new-sha");
});

test("RDS CA status classifies AWS fetch failures without live AWS", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response("unavailable", { status: 503, statusText: "Slow Down" })
  );

  const status = await getStatus();

  expect(status.status).toBe(RdsCaBundleStatus.FetchFailed);
  expect(status.message).toContain("Failed to fetch RDS CA bundle");
});

test("RDS CA status classifies invalid bundles without live AWS", async () => {
  vi.stubGlobal("fetch", async () => new Response("not a certificate"));

  const status = await getStatus();

  expect(status.status).toBe(RdsCaBundleStatus.InvalidBundle);
  expect(status.message).toContain("Expected at least");
});

test("RDS CA status writes unexpected failure when embedded bundle setup fails", async () => {
  const status = await getStatus(() =>
    Promise.reject(new Error("generated module unavailable"))
  );

  expect(status).toEqual({
    message: "generated module unavailable",
    sourceUrl:
      "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
    status: RdsCaBundleStatus.UnexpectedFailure,
  });
});

test("RDS CA status classifier preserves unexpected failure fallback", () => {
  expect(classifyStatusError(new Error("filesystem unavailable"))).toBe(
    RdsCaBundleStatus.UnexpectedFailure
  );
});
