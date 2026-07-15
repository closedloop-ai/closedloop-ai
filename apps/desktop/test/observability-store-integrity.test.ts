/**
 * @file observability-store-integrity.test.ts
 * @description FEA-1999 — the Observability.storeIntegrityResult emit cadence:
 * detect once, re-detect on a changed object set, heartbeat while persisting,
 * recover, and a single clean signal per launch. The diagnostics ride as a typed
 * field so the failing check name and affected object reach the backend.
 */
import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { Observability } from "../src/main/observability.js";
import type { StoreIntegrityDiagnostics } from "../src/main/telemetry-protocol.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry-service.js";

afterEach(() => {
  Observability.reset();
  mock.restoreAll();
});

function healthy(): StoreIntegrityDiagnostics {
  return {
    healthy: true,
    durationMs: 1,
    checksRun: ["quick_check", "index_presence"],
    issueCount: 0,
    issues: [],
    truncated: false,
  };
}

function failing(object: string): StoreIntegrityDiagnostics {
  return {
    healthy: false,
    durationMs: 1,
    checksRun: ["quick_check", "index_presence"],
    issueCount: 1,
    issues: [
      {
        check: "index_presence",
        category: "missing_index",
        object,
        objectType: "index",
      },
    ],
    truncated: false,
  };
}

function initCapturing(): EnrichedTelemetryEvent[] {
  const events: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => events.push(event) });
  return events;
}

describe("Observability.storeIntegrityResult", () => {
  test("first healthy probe emits one clean signal; repeats are suppressed", () => {
    const events = initCapturing();
    Observability.storeIntegrityResult(healthy());
    Observability.storeIntegrityResult(healthy());
    assert.equal(events.length, 1);
    assert.equal(events[0].category, "store.integrity.healthy");
    assert.equal(events[0].severity, "info");
  });

  test("failure emits failure_detected (error) carrying the typed diagnostics", () => {
    const events = initCapturing();
    Observability.storeIntegrityResult(failing("idx_events_session_id"));
    assert.equal(events.length, 1);
    assert.equal(events[0].category, "store.integrity.failure_detected");
    assert.equal(events[0].severity, "error");
    assert.equal(
      events[0].diagnostics?.storeIntegrity?.issues[0]?.object,
      "idx_events_session_id"
    );
  });

  test("an identical persisting failure does not re-emit before the heartbeat", () => {
    const events = initCapturing();
    Observability.storeIntegrityResult(failing("idx_a"));
    Observability.storeIntegrityResult(failing("idx_a"));
    assert.equal(events.length, 1);
  });

  test("a changed affected-object set re-emits failure_detected", () => {
    const events = initCapturing();
    Observability.storeIntegrityResult(failing("idx_a"));
    Observability.storeIntegrityResult(failing("idx_b"));
    assert.equal(events.length, 2);
    assert.equal(events[1].category, "store.integrity.failure_detected");
  });

  test("a persisting failure re-emits failure_persistent after the heartbeat", () => {
    let fakeNow = 1_000_000;
    mock.method(Date, "now", () => fakeNow);
    const events = initCapturing();
    Observability.storeIntegrityResult(failing("idx_a"));
    fakeNow += 61 * 60 * 1000; // > 1h heartbeat
    Observability.storeIntegrityResult(failing("idx_a"));
    assert.equal(events.length, 2);
    assert.equal(events[1].category, "store.integrity.failure_persistent");
    assert.equal(events[1].severity, "error");
  });

  test("recovery after a failure emits recovered (info)", () => {
    const events = initCapturing();
    Observability.storeIntegrityResult(failing("idx_a"));
    Observability.storeIntegrityResult(healthy());
    assert.equal(events.length, 2);
    assert.equal(events[1].category, "store.integrity.recovered");
    assert.equal(events[1].severity, "info");
  });

  test("corruption growth beyond the issue cap re-emits failure_detected", () => {
    // Same first-N issue objects but a higher total count (truncated payload):
    // the cadence must re-detect rather than stay silent.
    const events = initCapturing();
    const base = failing("idx_a");
    Observability.storeIntegrityResult({
      ...base,
      issueCount: 20,
      truncated: true,
    });
    Observability.storeIntegrityResult({
      ...base,
      issueCount: 25,
      truncated: true,
    });
    assert.equal(events.length, 2);
    assert.equal(events[1].category, "store.integrity.failure_detected");
  });

  test("the message never carries object names or row content", () => {
    const events = initCapturing();
    Observability.storeIntegrityResult(failing("idx_secret_name"));
    assert.equal(events[0].message?.includes("idx_secret_name"), false);
  });
});
