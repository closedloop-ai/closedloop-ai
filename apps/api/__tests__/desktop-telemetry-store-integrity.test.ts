/**
 * @file desktop-telemetry-store-integrity.test.ts
 * @description FEA-1999 — end-to-end: a desktop `store.integrity.*` event with a
 * typed `storeIntegrity` payload passes the handler's schema validation and the
 * structured fields (failing check name + affected object) reach the emitted log.
 */
import { log } from "@repo/observability/log";
import { TelemetryCategory } from "@repo/observability/telemetry/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTelemetryEvent,
  type TelemetryHandlerContext,
} from "@/lib/desktop-telemetry-handler";

const COMPUTE_TARGET_ID = "target-test-fea1999";

const context: TelemetryHandlerContext = {
  authenticatedTargetId: COMPUTE_TARGET_ID,
};

function storeIntegrityEvent(storeIntegrity: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.StoreIntegrityFailureDetected,
    severity: "error",
    timestamp: "2026-06-25T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: COMPUTE_TARGET_ID,
    },
    diagnostics: { storeIntegrity },
  };
}

describe("handleTelemetryEvent — store integrity (FEA-1999)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts the event and forwards the typed storeIntegrity diagnostics", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      storeIntegrityEvent({
        healthy: false,
        durationMs: 7,
        checksRun: ["quick_check", "index_presence"],
        issueCount: 1,
        issues: [
          {
            check: "quick_check",
            category: "missing_index_entry",
            object: "idx_events_session_id",
            objectType: "index",
          },
        ],
        truncated: false,
      }),
      context
    );

    expect(result.ok).toBe(true);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = infoSpy.mock.calls[0]?.[1] as {
      category: string;
      diagnostics?: { storeIntegrity?: { issues: { object?: string }[] } };
    };
    expect(logged.category).toBe("store.integrity.failure_detected");
    expect(logged.diagnostics?.storeIntegrity?.issues[0]?.object).toBe(
      "idx_events_session_id"
    );
  });
});
