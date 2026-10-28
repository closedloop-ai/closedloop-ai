/**
 * @file telemetry-store-integrity.test.ts
 * @description FEA-1999 — the storeIntegrity diagnostics must survive the
 * desktop telemetry wire schema (the top-level diagnostics object strips unknown
 * keys, so an un-mirrored field would be silently dropped before Datadog), and
 * its bounded shape must hold (capped issues, identifier-length cap, enums).
 */
import { describe, expect, it } from "vitest";
import { buildDesktopTelemetryPayload } from "../telemetry/emitter";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import {
  StorageExhaustionReason,
  StoreIntegrityCheckName,
  StoreIntegrityIssueCategory,
} from "../telemetry/store-integrity";
import { TelemetryCategory } from "../telemetry/telemetry-category";

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

  it("accepts the mirrored ISS-6337 disk-full signal, reason in the object slot", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 3,
        checksRun: [StoreIntegrityCheckName.StorageExhaustion],
        issueCount: 1,
        issues: [
          {
            check: StoreIntegrityCheckName.StorageExhaustion,
            category: StoreIntegrityIssueCategory.StorageExhausted,
            // The bounded StorageExhaustionReason, never a filesystem path.
            object: "sqlite_full",
            objectType: "unknown",
          },
        ],
        truncated: false,
      })
    );

    // Un-mirroring either enum member drops the WHOLE event as
    // `telemetry.validation_failed`, not just the one field — so this failing
    // means the desktop would emit disk-full telemetry into a black hole.
    expect(parsed.success).toBe(true);
  });

  it("preserves the Desktop cloud-overlay write failure at the wire boundary", () => {
    const payload = buildDesktopTelemetryPayload(
      eventWith({
        healthy: false,
        durationMs: 0,
        checksRun: [StoreIntegrityCheckName.CloudGithubOverlay],
        issueCount: 1,
        issues: [
          {
            check: StoreIntegrityCheckName.CloudGithubOverlay,
            category:
              StoreIntegrityIssueCategory.CloudGithubOverlayWriteFailure,
            object: "cloud_github_branch_overlays",
            objectType: "table",
          },
        ],
        truncated: false,
      })
    );

    expect(payload.category).toBe(
      TelemetryCategory.StoreIntegrityFailureDetected
    );
    expect(payload.diagnostics).toMatchObject({
      storeIntegrity: {
        checksRun: [StoreIntegrityCheckName.CloudGithubOverlay],
        issues: [
          {
            check: StoreIntegrityCheckName.CloudGithubOverlay,
            category:
              StoreIntegrityIssueCategory.CloudGithubOverlayWriteFailure,
          },
        ],
      },
    });
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

  it("an unreadable invocation-outbox timestamp survives the wire schema (ISS-6209)", () => {
    // Same trap as the WAL / FK / token additions above, and the one this change
    // is most exposed to: the desktop producer mirrors these two names as a BARE
    // STRING UNION in its own `telemetry-protocol.ts`, with no shared import from
    // this module — so nothing but this test couples the two halves. A typo on
    // either side, or landing the producer half alone, makes this schema reject
    // the WHOLE event as telemetry.validation_failed, taking the four other
    // store-integrity checks down with it and leaving every corrupt-outbox report
    // invisible on the one monitored path ISS-6209 exists to reach.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 7,
        checksRun: [
          StoreIntegrityCheckName.QuickCheck,
          StoreIntegrityCheckName.IndexPresence,
          StoreIntegrityCheckName.InvocationSyncOutbox,
        ],
        issueCount: 1,
        issues: [
          {
            check: StoreIntegrityCheckName.InvocationSyncOutbox,
            category:
              StoreIntegrityIssueCategory.UnreadableInvocationSyncOutboxTimestamp,
            object: "agent_component_invocation_sync_outbox",
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
      StoreIntegrityCheckName.InvocationSyncOutbox
    );
    expect(integrity?.issues[0]?.category).toBe(
      StoreIntegrityIssueCategory.UnreadableInvocationSyncOutboxTimestamp
    );
    expect(integrity?.issues[0]?.object).toBe(
      "agent_component_invocation_sync_outbox"
    );
  });

  it("an abandoned invocation-outbox part survives the wire schema (ISS-5855)", () => {
    // The same producer/consumer coupling the ISS-6209 case above documents, for
    // the category that reports permanent DATA LOSS rather than corruption.
    //
    // The payload deliberately carries the RAW STRING rather than the const, which
    // is the one difference from the case above and the reason this test can fail
    // at all. `apps/desktop` does not depend on this package — it mirrors these
    // values as a bare string union and its classifier pushes this exact literal —
    // so a test written entirely against the const moves in lockstep with any edit
    // to it and would stay green while the two halves drifted apart. This literal
    // stands in for the desktop producer; if the member below is renamed, removed,
    // or given a different value, `z.enum` rejects it and the WHOLE event becomes
    // telemetry.validation_failed, taking the corruption report riding the same
    // check name down with it.
    const desktopEmittedCategory = "abandoned_invocation_sync_outbox_part";
    expect(StoreIntegrityIssueCategory.AbandonedInvocationSyncOutboxPart).toBe(
      desktopEmittedCategory
    );

    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 9,
        checksRun: [StoreIntegrityCheckName.InvocationSyncOutbox],
        issueCount: 2,
        issues: [
          {
            check: StoreIntegrityCheckName.InvocationSyncOutbox,
            category:
              StoreIntegrityIssueCategory.UnreadableInvocationSyncOutboxTimestamp,
            object: "agent_component_invocation_sync_outbox",
            objectType: "table",
          },
          {
            check: StoreIntegrityCheckName.InvocationSyncOutbox,
            category: desktopEmittedCategory,
            object: "agent_component_invocation_sync_outbox",
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
    expect(integrity?.issues.map((issue) => issue.category)).toEqual([
      StoreIntegrityIssueCategory.UnreadableInvocationSyncOutboxTimestamp,
      desktopEmittedCategory,
    ]);
  });

  it("caps checksRun at the enum's cardinality, and no producer can overrun it (ISS-5444 / ISS-7488)", () => {
    // The enum's own cardinality IS the cap, and the full fleet must validate: a
    // cap that fell BEHIND the enum would drop the WHOLE event as
    // telemetry.validation_failed rather than truncate the list.
    //
    // ISS-7488 CHANGED THE SECOND HALF OF THIS EXPECTATION. It asserted that one
    // KNOWN name past the cap is REJECTED, which pinned the bound by overrunning
    // it — and it could only be overrun because the cap rested on an
    // `apps/desktop` invariant, that the probe appends each name at most once per
    // run. This schema is the half that may not assume anything about a desktop
    // newer than the deploy, so a probe that re-ran a check after a retry lost
    // the whole event to `too_big`. The preprocess now reduces the array to
    // DISTINCT names, which makes an overrun UNREACHABLE for any string input
    // rather than rejected — so the surviving pin is that the worst case a
    // producer can construct still lands inside the cap, asserted below.
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

    // The worst case: every name this build knows, one of them re-run, plus two
    // a newer probe invented. Fourteen entries against a cap of thirteen before
    // the dedupe; inside it after.
    const worstCase = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: true,
        durationMs: 9,
        checksRun: [
          ...everyCheck,
          StoreIntegrityCheckName.QuickCheck,
          "probe_from_a_newer_build",
          "another_probe_from_a_newer_build",
        ],
        issueCount: 0,
        issues: [],
        truncated: false,
      })
    );

    expect(worstCase.success).toBe(true);
    const worstCaseChecks = worstCase.success
      ? worstCase.data.diagnostics?.storeIntegrity?.checksRun
      : undefined;
    expect(worstCaseChecks).toEqual(everyCheck);
    expect(worstCaseChecks?.length).toBe(
      Object.values(StoreIntegrityCheckName).length
    );
  });

  it("folds a check name this build does not know, keeping the probe result", () => {
    // ISS-7488 CHANGED THIS EXPECTATION. It asserted rejection. Rejection threw
    // away the probe's verdict, its duration, and every issue it found — 5 of the
    // 33 desktop payloads production refused over the 30 days to 2026-09-14 were
    // unrecognised members of this array. The name now coarsens onto `unknown`.
    // The issue CATEGORY below deliberately still rejects, because it is what
    // bounds the free-text `object` slot beside it.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({
        healthy: false,
        durationMs: 1,
        checksRun: ["wal_frame_probe_v2"],
        issueCount: 0,
        issues: [],
        truncated: false,
      })
    );

    expect(parsed.success).toBe(true);
    const integrity = parsed.success
      ? parsed.data.diagnostics?.storeIntegrity
      : undefined;
    expect(integrity?.checksRun).toEqual([StoreIntegrityCheckName.Unknown]);
    expect(integrity?.healthy).toBe(false);
    expect(integrity?.durationMs).toBe(1);
  });

  /**
   * ISS-6337 — `object` is one loose 128-char string shared by every category,
   * so nothing but a per-category bound stops a malformed or version-skewed
   * producer from putting a FILESYSTEM PATH in this slot. A path carries the OS
   * account name (the ISS-6228 / ISS-6229 leak class), and the producer being
   * bounded today is not what keeps the wire bounded.
   */
  describe("storage_exhausted holds its own closed vocabulary", () => {
    function storageEvent(object: string | undefined) {
      return eventWith({
        healthy: false,
        durationMs: 3,
        checksRun: [StoreIntegrityCheckName.StorageExhaustion],
        issueCount: 1,
        issues: [
          {
            check: StoreIntegrityCheckName.StorageExhaustion,
            category: StoreIntegrityIssueCategory.StorageExhausted,
            ...(object === undefined ? {} : { object, objectType: "unknown" }),
          },
        ],
        truncated: false,
      });
    }

    it.each(Object.values(StorageExhaustionReason))(
      "accepts the bounded reason %s",
      (reason) => {
        expect(
          desktopTelemetryEventSchema.safeParse(storageEvent(reason)).success
        ).toBe(true);
      }
    );

    it("accepts the issue with no object at all", () => {
      expect(
        desktopTelemetryEventSchema.safeParse(storageEvent(undefined)).success
      ).toBe(true);
    });

    it.each([
      ["a filesystem path", "/Users/alice/Library/agent-dashboard.sqlite"],
      ["a home-relative path", "~/Library/Application Support/store-wal"],
      ["a Windows path", "C:\\Users\\alice\\store.sqlite"],
      ["an unknown future reason", "sqlite_full_but_worse"],
      ["a raw driver message", "SQLITE_FULL: database or disk is full"],
      ["an empty string", ""],
    ])("rejects %s in the object slot", (_label, object) => {
      expect(
        desktopTelemetryEventSchema.safeParse(storageEvent(object)).success
      ).toBe(false);
    });

    it("leaves OTHER categories' object slot alone", () => {
      // The bound is per-category: a table name is still legitimate elsewhere,
      // so this must not have narrowed the whole issue array.
      expect(
        desktopTelemetryEventSchema.safeParse(
          eventWith({
            healthy: false,
            durationMs: 3,
            checksRun: [StoreIntegrityCheckName.IndexPresence],
            issueCount: 1,
            issues: [
              {
                check: StoreIntegrityCheckName.IndexPresence,
                category: StoreIntegrityIssueCategory.MissingIndex,
                object: "sessions_status_idx",
                objectType: "index",
              },
            ],
            truncated: false,
          })
        ).success
      ).toBe(true);
    });
  });
});
