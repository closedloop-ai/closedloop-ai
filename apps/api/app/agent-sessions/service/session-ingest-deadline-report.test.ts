/**
 * @file session-ingest-deadline-report.test.ts
 * @description ISS-8145 — what the deadline signal actually emits.
 *
 * The condition this module reports is the one that REPEATS: a session whose
 * own slice cannot fit its transaction deadline re-sends the identical payload
 * on every tick, forever. So every property of the emission is paid on every
 * retry, which is why the log line is held to both of its bounds here — the
 * sample COUNT and each sampled identifier's SIZE (whitlockk review) — and why the
 * "nothing was a deadline" path is pinned to emit nothing at all rather than a
 * zero that would make the metric measure traffic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SAMPLED_IDENTIFIER_BYTES,
  SAMPLED_IDENTIFIER_TRUNCATION_MARKER,
} from "./sampled-identifier";
import {
  isSliceDeadlineFailure,
  reportLegacyBatchDeadlineFailure,
  reportSessionIngestDeadlineExceeded,
} from "./session-ingest-deadline-report";
import { SessionSyncMetric } from "./session-sync-metrics";

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, warn: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

const CONTEXT = {
  organizationId: "org-1",
  userId: "user-1",
  computeTargetId: "target-1",
};

/** Prisma's interactive-transaction timeout, the one failure this path reports. */
const DEADLINE_ERROR = { code: "P2028", message: "Transaction already closed" };

/** The sample cap the log line applies, restated so a change to it fails here. */
const EXPECTED_SAMPLE = 5;

describe("session ingest deadline report", () => {
  beforeEach(() => {
    mocks.logError.mockClear();
    mocks.emitTelemetryMetric.mockClear();
  });

  it("bounds each sampled id by BYTES, not only by how many are logged", () => {
    const oversized = "a".repeat(MAX_SAMPLED_IDENTIFIER_BYTES * 4);

    reportSessionIngestDeadlineExceeded(
      CONTEXT,
      Array.from({ length: EXPECTED_SAMPLE }, () => oversized)
    );

    const logged = loggedSessionIds();
    expect(logged).toHaveLength(EXPECTED_SAMPLE);
    for (const id of logged) {
      expect(Buffer.byteLength(id, "utf8")).toBeLessThanOrEqual(
        MAX_SAMPLED_IDENTIFIER_BYTES
      );
      expect(id.endsWith(SAMPLED_IDENTIFIER_TRUNCATION_MARKER)).toBe(true);
    }
  });

  it("passes an id that already fits through untouched", () => {
    // The positive control on the same selector: without it, a bound that
    // truncated or marked EVERY id would satisfy the assertion above.
    reportSessionIngestDeadlineExceeded(CONTEXT, ["session-fits-whole"]);

    expect(loggedSessionIds()).toEqual(["session-fits-whole"]);
  });

  it("samples at most five ids while counting every one", () => {
    const ids = Array.from(
      { length: EXPECTED_SAMPLE + 3 },
      (_, index) => `session-${index}`
    );

    reportSessionIngestDeadlineExceeded(CONTEXT, ids);

    expect(loggedSessionIds()).toHaveLength(EXPECTED_SAMPLE);
    expect(loggedField("deadlineExceededSessionCount")).toBe(ids.length);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: SessionSyncMetric.IngestSessionDeadlineExceeded,
        count: ids.length,
      })
    );
  });

  it("emits nothing when no session hit its deadline", () => {
    // A zero here would make the metric measure traffic rather than the
    // condition, so absence is the contract, not an omission.
    reportSessionIngestDeadlineExceeded(CONTEXT, []);

    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalled();
  });

  it("reports the legacy batch path only for a deadline failure", () => {
    reportLegacyBatchDeadlineFailure(CONTEXT, DEADLINE_ERROR, "session-legacy");

    expect(loggedSessionIds()).toEqual(["session-legacy"]);
    expect(mocks.emitTelemetryMetric).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-deadline legacy failure unreported", () => {
    reportLegacyBatchDeadlineFailure(
      CONTEXT,
      { code: "P2002", message: "Unique constraint failed" },
      "session-legacy"
    );

    expect(mocks.logError).not.toHaveBeenCalled();
    expect(mocks.emitTelemetryMetric).not.toHaveBeenCalled();
  });

  it("classifies only the transaction-timeout code as a deadline", () => {
    expect(isSliceDeadlineFailure(DEADLINE_ERROR)).toBe(true);
    expect(isSliceDeadlineFailure({ code: "P2002" })).toBe(false);
    expect(isSliceDeadlineFailure(new Error("boom"))).toBe(false);
  });
});

function loggedField(field: string): unknown {
  const payload = mocks.logError.mock.calls[0]?.[1] as Record<string, unknown>;
  return payload[field];
}

function loggedSessionIds(): string[] {
  return loggedField("externalSessionIds") as string[];
}
