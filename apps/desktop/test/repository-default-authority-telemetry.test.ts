/** ISS-5838 bounded, content-free write-failure telemetry coverage. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Observability } from "../src/main/telemetry/observability.js";
import { reportRepositoryDefaultAuthorityWriteFailure } from "../src/main/telemetry/repository-default-authority-telemetry.js";
import type { EnrichedTelemetryEvent } from "../src/main/telemetry/telemetry-service.js";

test("authority write failures emit once without changing integrity cadence", () => {
  const events: EnrichedTelemetryEvent[] = [];
  Observability.init({ telemetrySend: (event) => events.push(event) });
  try {
    reportRepositoryDefaultAuthorityWriteFailure();
    reportRepositoryDefaultAuthorityWriteFailure();
    Observability.storeIntegrityResult({
      healthy: true,
      durationMs: 1,
      checksRun: ["quick_check", "index_presence"],
      issueCount: 0,
      issues: [],
      truncated: false,
    });

    assert.equal(events.length, 2);
    assert.equal(events[0]?.category, "store.integrity.failure_detected");
    assert.deepEqual(events[0]?.diagnostics?.storeIntegrity, {
      healthy: false,
      durationMs: 0,
      checksRun: ["repository_default_authority"],
      issueCount: 1,
      issues: [
        {
          check: "repository_default_authority",
          category: "repository_default_authority_write_failure",
          object: "repository_default_authorities",
          objectType: "table",
        },
      ],
      truncated: false,
    });
    assert.equal(events[1]?.category, "store.integrity.healthy");
    assert.equal(
      events[0]?.message,
      "Repository default authority persistence failed"
    );
    assert.equal(JSON.stringify(events).includes("identity"), false);
  } finally {
    Observability.reset();
  }
});
