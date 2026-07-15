/**
 * @file telemetry-store-integrity.test.ts
 * @description FEA-1999 — the storeIntegrity diagnostics must survive the
 * desktop telemetry wire schema (the top-level diagnostics object strips unknown
 * keys, so an un-mirrored field would be silently dropped before Datadog), and
 * its bounded shape must hold (capped issues, identifier-length cap, enums).
 */
import { describe, expect, it } from "vitest";
import {
  desktopTelemetryEventSchema,
  TelemetryCategory,
} from "../telemetry/schema";

function eventWith(storeIntegrity: unknown) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.StoreIntegrityFailureDetected,
    severity: "error",
    timestamp: "2026-06-25T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { storeIntegrity },
  };
}

describe("storeIntegrity diagnostics wire schema (FEA-1999)", () => {
  it("survives validation with the failing check name and affected object", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 12,
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
      })
    );
    expect(parsed.success).toBe(true);
    const integrity = parsed.success
      ? parsed.data.diagnostics?.storeIntegrity
      : undefined;
    expect(integrity?.issues[0]?.object).toBe("idx_events_session_id");
    expect(integrity?.issues[0]?.category).toBe("missing_index_entry");
  });

  it("a healthy result validates and reaches the backend", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: true,
        durationMs: 3,
        checksRun: ["quick_check", "index_presence"],
        issueCount: 0,
        issues: [],
        truncated: false,
      })
    );
    expect(parsed.success).toBe(true);
  });

  it("strips unexpected keys inside an issue (e.g. a leaked raw message)", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 1,
        checksRun: ["quick_check"],
        issueCount: 1,
        issues: [
          {
            check: "quick_check",
            category: "other",
            rawMessage:
              "row 5 missing from index idx_x with value secret@x.com",
          },
        ],
        truncated: false,
      })
    );
    expect(parsed.success).toBe(true);
    const issue = parsed.success
      ? parsed.data.diagnostics?.storeIntegrity?.issues[0]
      : undefined;
    expect(issue).toBeDefined();
    expect("rawMessage" in (issue ?? {})).toBe(false);
  });

  it("rejects an unknown issue category and an over-long object", () => {
    expect(
      desktopTelemetryEventSchema.safeParse(
        eventWith({
          healthy: false,
          durationMs: 1,
          checksRun: ["quick_check"],
          issueCount: 1,
          issues: [{ check: "quick_check", category: "totally_made_up" }],
          truncated: false,
        })
      ).success
    ).toBe(false);

    expect(
      desktopTelemetryEventSchema.safeParse(
        eventWith({
          healthy: false,
          durationMs: 1,
          checksRun: ["quick_check"],
          issueCount: 1,
          issues: [
            {
              check: "quick_check",
              category: "other",
              object: "x".repeat(200),
            },
          ],
          truncated: false,
        })
      ).success
    ).toBe(false);
  });
});
