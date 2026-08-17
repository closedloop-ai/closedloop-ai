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
  StoreIntegrityCheckName,
  StoreIntegrityIssueCategory,
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
  it("accepts the mirrored repository-default authority integrity signal", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 0,
        checksRun: [StoreIntegrityCheckName.RepositoryDefaultAuthority],
        issueCount: 2,
        issues: [
          {
            check: StoreIntegrityCheckName.RepositoryDefaultAuthority,
            category:
              StoreIntegrityIssueCategory.MalformedRepositoryDefaultAuthority,
            object: "repository_default_authorities",
            objectType: "table",
          },
          {
            check: StoreIntegrityCheckName.RepositoryDefaultAuthority,
            category:
              StoreIntegrityIssueCategory.RepositoryDefaultAuthorityWriteFailure,
            object: "repository_default_authorities",
            objectType: "table",
          },
        ],
        truncated: false,
      })
    );

    expect(parsed.success).toBe(true);
  });

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

  it("a WAL-frame-probe failure survives the wire schema (ISS-4818)", () => {
    // The producer started emitting `wal_frame_probe` / `wal_probe_failure`. The
    // API handler validates with THIS schema and drops the WHOLE event as
    // telemetry.validation_failed on an unknown enum member — so a producer-only
    // addition would have made every WAL anomaly invisible on the very monitored
    // path the change exists to reach.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 4,
        checksRun: [
          StoreIntegrityCheckName.QuickCheck,
          StoreIntegrityCheckName.IndexPresence,
          StoreIntegrityCheckName.WalFrameProbe,
        ],
        issueCount: 1,
        issues: [
          {
            check: StoreIntegrityCheckName.WalFrameProbe,
            category: StoreIntegrityIssueCategory.WalProbeFailure,
            object: "malformed_row",
            objectType: "unknown",
          },
        ],
        truncated: false,
      })
    );

    expect(parsed.success).toBe(true);
    const integrity = parsed.success
      ? parsed.data.diagnostics?.storeIntegrity
      : undefined;
    expect(integrity?.checksRun).toContain(
      StoreIntegrityCheckName.WalFrameProbe
    );
    expect(integrity?.issues[0]?.category).toBe(
      StoreIntegrityIssueCategory.WalProbeFailure
    );
    expect(integrity?.issues[0]?.object).toBe("malformed_row");
  });

  it("a foreign-key integrity finding survives the wire schema (ISS-5102)", () => {
    // Same hazard as the ISS-4818 case above: the producer now emits
    // `foreign_key_check` / `foreign_key_violation` / `orphaned_row`, and a
    // producer-only addition would have the API handler drop the WHOLE event as
    // telemetry.validation_failed — making every dangling-FK store invisible.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 6,
        checksRun: [
          StoreIntegrityCheckName.QuickCheck,
          StoreIntegrityCheckName.IndexPresence,
          StoreIntegrityCheckName.ForeignKeyCheck,
        ],
        issueCount: 2,
        issues: [
          {
            check: StoreIntegrityCheckName.ForeignKeyCheck,
            category: StoreIntegrityIssueCategory.ForeignKeyViolation,
            object: "agent_component_invocations",
            objectType: "table",
          },
          {
            check: StoreIntegrityCheckName.ForeignKeyCheck,
            category: StoreIntegrityIssueCategory.OrphanedRow,
            object: "events",
            objectType: "table",
          },
        ],
        truncated: false,
      })
    );

    expect(parsed.success).toBe(true);
    const integrity = parsed.success
      ? parsed.data.diagnostics?.storeIntegrity
      : undefined;
    expect(integrity?.checksRun).toContain(
      StoreIntegrityCheckName.ForeignKeyCheck
    );
    expect(integrity?.issues.map((issue) => issue.category)).toEqual([
      StoreIntegrityIssueCategory.ForeignKeyViolation,
      StoreIntegrityIssueCategory.OrphanedRow,
    ]);
  });

  it("an impossible token total survives the wire schema (ISS-5342)", () => {
    // Same trap as the WAL addition above: the producer now reports a token
    // total the parity read cannot legitimately produce (no nonnegative CHECK
    // exists on either token table), and this schema drops the WHOLE event on an
    // unknown enum member — so the category has to land here in the same change
    // or every corrupt-store report is invisible on the monitored path.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 6,
        checksRun: [
          StoreIntegrityCheckName.QuickCheck,
          StoreIntegrityCheckName.IndexPresence,
          StoreIntegrityCheckName.TokenParity,
        ],
        issueCount: 1,
        issues: [
          {
            check: StoreIntegrityCheckName.TokenParity,
            category: StoreIntegrityIssueCategory.TokenTotalOutOfRange,
            object: "usage_input_tokens",
            objectType: "unknown",
          },
        ],
        truncated: false,
      })
    );

    expect(parsed.success).toBe(true);
    const integrity = parsed.success
      ? parsed.data.diagnostics?.storeIntegrity
      : undefined;
    expect(integrity?.checksRun).toContain(StoreIntegrityCheckName.TokenParity);
    expect(integrity?.issues[0]?.category).toBe(
      StoreIntegrityIssueCategory.TokenTotalOutOfRange
    );
    expect(integrity?.issues[0]?.object).toBe("usage_input_tokens");
  });

  it("caps checksRun at the enum's cardinality, not a hand-tuned literal (ISS-5444)", () => {
    // The producer already fills every name in one run, and appends each at most
    // once — so the enum's own cardinality IS the cap. Both halves matter: the
    // full fleet must validate (a cap that fell BEHIND the enum would drop the
    // WHOLE event as telemetry.validation_failed rather than truncate the list),
    // and one name past it must be rejected (which is what pins the bound to the
    // enum instead of to any literal with slack above it).
    const everyCheck = Object.values(StoreIntegrityCheckName);
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: true,
        durationMs: 9,
        checksRun: everyCheck,
        issueCount: 0,
        issues: [],
        truncated: false,
      })
    );

    expect(parsed.success).toBe(true);
    const integrity = parsed.success
      ? parsed.data.diagnostics?.storeIntegrity
      : undefined;
    expect(integrity?.checksRun).toEqual(everyCheck);

    expect(
      desktopTelemetryEventSchema.safeParse(
        eventWith({
          healthy: true,
          durationMs: 9,
          checksRun: [...everyCheck, StoreIntegrityCheckName.QuickCheck],
          issueCount: 0,
          issues: [],
          truncated: false,
        })
      ).success
    ).toBe(false);
  });

  it("still rejects a check name this build does not know", () => {
    expect(
      desktopTelemetryEventSchema.safeParse(
        eventWith({
          healthy: false,
          durationMs: 1,
          checksRun: ["wal_frame_probe_v2"],
          issueCount: 0,
          issues: [],
          truncated: false,
        })
      ).success
    ).toBe(false);
  });
});
