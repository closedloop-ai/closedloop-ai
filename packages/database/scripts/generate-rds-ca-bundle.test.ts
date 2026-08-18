import { afterEach, expect, test, vi } from "vitest";
import {
  classifyStatusError,
  getStatus,
  RdsCaBundleStatus,
  type RdsCaBundleStatusReport,
} from "./generate-rds-ca-bundle";
import { AWS_RDS_CA_BUNDLE } from "./rds-ca-bundle";

const BACKTICK = String.fromCharCode(96);

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

/*
 * The cases below drive a bundle that actually parses, which the failure tests
 * above never do. The embedded bundle is replayed as the upstream response --
 * 108 real RDS certificates -- rather than a hand-maintained fixture that would
 * drift from it.
 */

test("RDS CA status reports match when upstream equals the embedded bundle", async () => {
  vi.stubGlobal("fetch", async () => new Response(AWS_RDS_CA_BUNDLE));

  // No injected reader: this runs against the digest actually committed in
  // rds-ca-bundle.ts, so it also fails if that constant and the embedded PEM
  // ever disagree.
  const status = await getStatus();

  expect(status.status).toBe(RdsCaBundleStatus.Match);
  expect(status.upstreamSha256).toBe(status.embeddedSha256);
  expect(status.certificateCount).toBe(108);
});

test("RDS CA status reports drift when the embedded digest is stale", async () => {
  vi.stubGlobal("fetch", async () => new Response(AWS_RDS_CA_BUNDLE));

  const status = await getStatus(() => Promise.resolve("stale-digest"));

  expect(status.status).toBe(RdsCaBundleStatus.Drift);
  expect(status.embeddedSha256).toBe("stale-digest");
  // Drift must still report the upstream digest -- that is the value an
  // operator regenerates against.
  expect(status.upstreamSha256).not.toBe("stale-digest");
  expect(status.certificateCount).toBe(108);
});

/*
 * The embedded bundle is written into generated TypeScript inside a template
 * literal, so a backtick or an interpolation opener in the fetched PEM would be
 * executable code rather than data. Both must be refused before anything is
 * written.
 */

test("RDS CA status refuses a bundle containing a backtick", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response(`${AWS_RDS_CA_BUNDLE}\n${BACKTICK}`)
  );

  const status = await getStatus();

  expect(status.status).toBe(RdsCaBundleStatus.InvalidBundle);
  expect(status.message).toContain("template-literal metacharacters");
});

test("RDS CA status refuses a bundle containing an interpolation opener", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response(`${AWS_RDS_CA_BUNDLE}\n\${process.env}`)
  );

  const status = await getStatus();

  expect(status.status).toBe(RdsCaBundleStatus.InvalidBundle);
  expect(status.message).toContain("template-literal metacharacters");
});

test("RDS CA status classifier maps fetch and bundle failures to their own codes", () => {
  // Exercised indirectly above; pinned directly so a reworded upstream error
  // cannot silently downgrade either case to unexpected_failure.
  expect(
    classifyStatusError(new Error("Failed to fetch RDS CA bundle: HTTP 503"))
  ).toBe(RdsCaBundleStatus.FetchFailed);
  expect(
    classifyStatusError(new Error("Non-RDS certificate in bundle: CN=evil"))
  ).toBe(RdsCaBundleStatus.InvalidBundle);
  expect(
    classifyStatusError(
      new Error("Bundle contains template-literal metacharacters")
    )
  ).toBe(RdsCaBundleStatus.InvalidBundle);
});

test("RDS CA status classifier survives a non-Error throw", () => {
  // A rejected fetch can carry anything; String() it rather than crash.
  expect(classifyStatusError("socket hang up")).toBe(
    RdsCaBundleStatus.UnexpectedFailure
  );
  expect(classifyStatusError(undefined)).toBe(
    RdsCaBundleStatus.UnexpectedFailure
  );
});
