/**
 * @file telemetry-skew-tolerance.test.ts
 * @description ISS-7488 — a desktop newer than this deploy must not lose its
 * WHOLE telemetry payload because one bounded field grew a member or one error
 * string grew past its cap.
 *
 * Measured against production on 2026-09-14, 33 desktop events were refused over
 * the preceding 30 days (3 in the last 7), every one of them under
 * `diagnostics`, in four places:
 *
 *   - `tokenCostPricingMiss.surface`   invalid_value  15
 *   - `collectorRecordsDropped.reason` invalid_value   8
 *   - `desktopUpdate.error`            too_big         7
 *   - `storeIntegrity.checksRun[n]`    invalid_value   5
 *
 * `desktopTelemetryEventSchema` validates the whole event, so each of those
 * refusals dropped every other diagnostic on the payload with it, and re-dropped
 * it on each retry.
 *
 * Each case therefore asserts the SURVIVING PAYLOAD, not just the folded field:
 * a test that checked only the field it fed would pass while the event was still
 * being thrown away. The unknown wire values are deliberately raw strings — the
 * point is a member no const in this repo has.
 */
import { describe, expect, it } from "vitest";
import { CollectorRecordsDroppedReason } from "../telemetry/collector-records-dropped-reason";
import { DesktopUpdateTrigger } from "../telemetry/desktop-lifecycle-triggers";
import {
  DESKTOP_DIAGNOSTICS_SKEW_POSTURE,
  DiagnosticsSkewPosture,
} from "../telemetry/diagnostics-skew-posture";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import {
  desktopTelemetryEventSchema,
  TokenCostPricingMissSurface,
} from "../telemetry/schema";
import {
  STORE_INTEGRITY_CHECK_NAMES,
  StoreIntegrityCheckName,
} from "../telemetry/store-integrity";
import { TelemetryCategory } from "../telemetry/telemetry-category";
import { DESKTOP_TELEMETRY_TRUNCATION_MARKER } from "../telemetry/tolerant-desktop-value";

/** The cap `desktopUpdate.error` / `desktopShutdown.error` clamp to. */
const ERROR_MAX_CHARS = 512;

/**
 * A sibling diagnostic on every event below. It has nothing to do with the field
 * under test, which is the point: it is what the refusal used to take with it,
 * so asserting it survived is what distinguishes "the field folded" from "the
 * payload arrived".
 */
const SIBLING_EXIT_CODE = 137;

function eventWith(category: string, diagnostics: Record<string, unknown>) {
  return {
    schemaVersion: "1",
    category,
    severity: "error",
    timestamp: "2026-09-14T00:00:00.000Z",
    trace: {
      commandId: "cmd-7488",
      operationId: "op-7488",
      computeTargetId: "target-7488",
    },
    diagnostics: { exitCode: SIBLING_EXIT_CODE, ...diagnostics },
  };
}

function parseDiagnostics(
  category: string,
  diagnostics: Record<string, unknown>
) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith(category, diagnostics)
  );
  if (!parsed.success) {
    // The ticket's whole subject: the event was thrown away. Naming the issues
    // is what tells a reader WHICH field is still refusing.
    throw new Error(
      `event refused by desktopTelemetryEventSchema: ${JSON.stringify(parsed.error.issues)}`
    );
  }
  return parsed.data.diagnostics;
}

describe("tokenCostPricingMiss.surface (ISS-7488)", () => {
  it("keeps a surface this build knows as itself", () => {
    const diagnostics = parseDiagnostics(
      TelemetryCategory.TokenCostPricingMiss,
      {
        tokenCostPricingMiss: {
          model: "gpt-5.6-sol",
          reason: "no_match",
          surface: "component_invocation",
        },
      }
    );

    expect(diagnostics?.tokenCostPricingMiss?.surface).toBe(
      TokenCostPricingMissSurface.ComponentInvocation
    );
  });

  it("folds a newer desktop's surface and keeps the rest of the event", () => {
    const diagnostics = parseDiagnostics(
      TelemetryCategory.TokenCostPricingMiss,
      {
        tokenCostPricingMiss: {
          model: "gpt-5.6-sol",
          reason: "no_match",
          surface: "a_costing_surface_this_build_has_never_heard_of",
          sessionId: "sess-7488",
        },
      }
    );

    expect(diagnostics?.tokenCostPricingMiss?.surface).toBe(
      TokenCostPricingMissSurface.Unknown
    );
    // The dimensions the refusal used to take with it.
    expect(diagnostics?.tokenCostPricingMiss?.model).toBe("gpt-5.6-sol");
    expect(diagnostics?.tokenCostPricingMiss?.sessionId).toBe("sess-7488");
    expect(diagnostics?.exitCode).toBe(SIBLING_EXIT_CODE);
  });
});

describe("collectorRecordsDropped.reason (ISS-7488)", () => {
  it("keeps a reason this build knows as itself", () => {
    const diagnostics = parseDiagnostics(
      TelemetryCategory.CollectorRecordsDropped,
      {
        collectorRecordsDropped: {
          reason: "session_response_budget",
          count: 4,
        },
      }
    );

    expect(diagnostics?.collectorRecordsDropped?.reason).toBe(
      CollectorRecordsDroppedReason.SessionResponseBudget
    );
  });

  it("folds a newer desktop's reason and keeps the count", () => {
    const diagnostics = parseDiagnostics(
      TelemetryCategory.CollectorRecordsDropped,
      {
        collectorRecordsDropped: {
          reason: "a_drop_path_this_build_has_never_heard_of",
          count: 4,
        },
      }
    );

    expect(diagnostics?.collectorRecordsDropped?.reason).toBe(
      CollectorRecordsDroppedReason.Unknown
    );
    expect(diagnostics?.collectorRecordsDropped?.count).toBe(4);
    expect(diagnostics?.exitCode).toBe(SIBLING_EXIT_CODE);
  });
});

describe("storeIntegrity.checksRun (ISS-7488)", () => {
  function storeIntegrityWith(checksRun: string[]) {
    return {
      storeIntegrity: {
        healthy: false,
        durationMs: 12,
        checksRun,
        issueCount: 1,
        issues: [{ check: "quick_check", category: "constraint" }],
        truncated: false,
      },
    };
  }

  it("keeps the check names this build knows as themselves", () => {
    const diagnostics = parseDiagnostics(
      TelemetryCategory.StoreIntegrityFailureDetected,
      storeIntegrityWith(["quick_check", "wal_frame_probe"])
    );

    expect(diagnostics?.storeIntegrity?.checksRun).toEqual([
      StoreIntegrityCheckName.QuickCheck,
      StoreIntegrityCheckName.WalFrameProbe,
    ]);
  });

  it("folds a newer desktop's check names and keeps the issues it found", () => {
    const diagnostics = parseDiagnostics(
      TelemetryCategory.StoreIntegrityFailureDetected,
      storeIntegrityWith([
        "quick_check",
        "a_probe_this_build_has_never_heard_of",
      ])
    );

    expect(diagnostics?.storeIntegrity?.checksRun).toEqual([
      StoreIntegrityCheckName.QuickCheck,
      StoreIntegrityCheckName.Unknown,
    ]);
    expect(diagnostics?.storeIntegrity?.issues).toHaveLength(1);
    expect(diagnostics?.storeIntegrity?.healthy).toBe(false);
    expect(diagnostics?.exitCode).toBe(SIBLING_EXIT_CODE);
  });

  it("stays inside the derived cap when a newer desktop runs extra checks", () => {
    // The `too_big` regression the fold exists to prevent: the array's cap is
    // this enum's cardinality, so without collapsing the unrecognised names onto
    // one entry a probe with several new checks would overrun it and lose the
    // event under a different Zod code.
    const everyKnownName = STORE_INTEGRITY_CHECK_NAMES.filter(
      (name) => name !== StoreIntegrityCheckName.Unknown
    );
    const newerProbeNames = ["probe_a", "probe_b", "probe_c", "probe_d"];

    const diagnostics = parseDiagnostics(
      TelemetryCategory.StoreIntegrityFailureDetected,
      storeIntegrityWith([...everyKnownName, ...newerProbeNames])
    );

    expect(diagnostics?.storeIntegrity?.checksRun).toEqual([
      ...everyKnownName,
      StoreIntegrityCheckName.Unknown,
    ]);
  });

  it("keeps one entry when a newer probe re-runs a check it already ran", () => {
    // marisolashgrove on #7398: folding only the UNRECOGNISED names left the
    // derived cap resting on an `apps/desktop` invariant — that the probe
    // appends each name at most once per run — which is precisely what this
    // schema may not assume about a desktop newer than the deploy.
    const diagnostics = parseDiagnostics(
      TelemetryCategory.StoreIntegrityFailureDetected,
      storeIntegrityWith([
        StoreIntegrityCheckName.QuickCheck,
        StoreIntegrityCheckName.IndexPresence,
        StoreIntegrityCheckName.QuickCheck,
      ])
    );

    expect(diagnostics?.storeIntegrity?.checksRun).toEqual([
      StoreIntegrityCheckName.QuickCheck,
      StoreIntegrityCheckName.IndexPresence,
    ]);
  });

  it("stays inside the derived cap when a newer probe repeats AND adds a check", () => {
    // The concrete counterexample from the review: every known name, one of them
    // re-run after a retry, plus a check this build has never heard of. Under a
    // fold that deduped only the unknown half this is one element over the cap
    // and the whole event dies `too_big` — the same drop, a different code.
    const everyKnownName = STORE_INTEGRITY_CHECK_NAMES.filter(
      (name) => name !== StoreIntegrityCheckName.Unknown
    );

    const diagnostics = parseDiagnostics(
      TelemetryCategory.StoreIntegrityFailureDetected,
      storeIntegrityWith([
        ...everyKnownName,
        StoreIntegrityCheckName.QuickCheck,
        "a_probe_from_a_newer_build",
      ])
    );

    expect(diagnostics?.storeIntegrity?.checksRun).toEqual([
      ...everyKnownName,
      StoreIntegrityCheckName.Unknown,
    ]);
    // The dimensions the `too_big` refusal would have taken with it.
    expect(diagnostics?.storeIntegrity?.issues).toHaveLength(1);
    expect(diagnostics?.exitCode).toBe(SIBLING_EXIT_CODE);
  });

  it("still refuses a structurally wrong check name", () => {
    // The tolerance is for unknown MEMBERS, not for a malformed payload: a
    // number where a name belongs is a producer bug, not version skew.
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(
        TelemetryCategory.StoreIntegrityFailureDetected,
        storeIntegrityWith([7] as unknown as string[])
      )
    );

    expect(parsed.success).toBe(false);
  });
});

describe("desktopUpdate.error (ISS-7488)", () => {
  it("leaves an error that fits exactly as it is, with no marker", () => {
    const error = "Error: ENOENT, open '/Applications/Closedloop.app'";
    const diagnostics = parseDiagnostics(
      TelemetryCategory.ElectronUpdateFailed,
      {
        desktopUpdate: { trigger: "updater-error", error, version: "1.2.3" },
      }
    );

    expect(diagnostics?.desktopUpdate?.error).toBe(error);
  });

  it("clamps an over-long error to its head and keeps the event", () => {
    const head = "Error: update install failed: ";
    const error = head + "x".repeat(4000);

    const diagnostics = parseDiagnostics(
      TelemetryCategory.ElectronUpdateFailed,
      {
        desktopUpdate: { trigger: "updater-error", error, version: "1.2.3" },
      }
    );

    const clamped = diagnostics?.desktopUpdate?.error;
    expect(clamped).toBeDefined();
    expect(clamped?.length).toBe(ERROR_MAX_CHARS);
    expect(clamped?.startsWith(head)).toBe(true);
    expect(clamped?.endsWith(DESKTOP_TELEMETRY_TRUNCATION_MARKER)).toBe(true);
    // The dimensions the refusal used to take with it.
    expect(diagnostics?.desktopUpdate?.trigger).toBe(
      DesktopUpdateTrigger.UpdaterError
    );
    expect(diagnostics?.desktopUpdate?.version).toBe("1.2.3");
    expect(diagnostics?.exitCode).toBe(SIBLING_EXIT_CODE);
  });

  it("clamps the shutdown sibling the same way", () => {
    const diagnostics = parseDiagnostics(
      TelemetryCategory.DesktopShutdownFailed,
      {
        desktopShutdown: {
          trigger: "shutdown-sequence",
          error: "y".repeat(4000),
          elapsedMs: 900,
        },
      }
    );

    expect(diagnostics?.desktopShutdown?.error?.length).toBe(ERROR_MAX_CHARS);
    expect(diagnostics?.desktopShutdown?.elapsedMs).toBe(900);
  });
});

describe("the clamped lifecycle errors reach the server sanitizer (ISS-7488)", () => {
  /**
   * The production order `handleTelemetryEvent` runs: validate the event, then
   * `sanitizeDesktopTelemetryDiagnostics` over what survived. Clamping rather
   * than refusing an over-long error ADMITS the head of a long updater or
   * shutdown failure — both raw `err.message`, neither scrubbed at the producer
   * — so the credential/home-path pass `logTail` already gets has to run on them
   * before anything is logged.
   */
  function sanitizedDiagnostics(
    category: string,
    diagnostics: Record<string, unknown>
  ) {
    return sanitizeDesktopTelemetryDiagnostics(
      parseDiagnostics(category, diagnostics)
    );
  }

  it("drops a credential line out of a clamped update error", () => {
    const diagnosis = "Update failed: could not stage the download";
    const error = `${diagnosis}\nAuthorization: Bearer sk_live_abcdefghijklmnopqrstuvwxyz\n${"x".repeat(4000)}`;

    const sanitized = sanitizedDiagnostics(
      TelemetryCategory.ElectronUpdateFailed,
      { desktopUpdate: { trigger: "updater-error", error } }
    );

    const scrubbed = sanitized?.desktopUpdate?.error;
    // Anchored on the surviving diagnosis so this cannot pass by being empty.
    expect(scrubbed).toContain(diagnosis);
    expect(scrubbed).not.toContain("sk_live_abcdefghijklmnopqrstuvwxyz");
  });

  it("collapses the home-rooted path out of an update error", () => {
    const sanitized = sanitizedDiagnostics(
      TelemetryCategory.ElectronUpdateFailed,
      {
        desktopUpdate: {
          trigger: "updater-error",
          error:
            "Error: EACCES, open '/Users/a.developer/Library/Caches/closedloop/update.zip'",
        },
      }
    );

    const scrubbed = sanitized?.desktopUpdate?.error;
    expect(scrubbed).toContain("~/Library/Caches/closedloop/update.zip");
    expect(scrubbed).not.toContain("a.developer");
    expect(scrubbed).toContain("EACCES");
  });

  it("scrubs the shutdown sibling the same way", () => {
    const sanitized = sanitizedDiagnostics(
      TelemetryCategory.DesktopShutdownFailed,
      {
        desktopShutdown: {
          trigger: "shutdown-sequence",
          error: "Timed out flushing /home/a.developer/.closedloop/store.db",
          elapsedMs: 900,
        },
      }
    );

    const scrubbed = sanitized?.desktopShutdown?.error;
    expect(scrubbed).toContain("~/.closedloop/store.db");
    expect(scrubbed).not.toContain("a.developer");
    expect(sanitized?.desktopShutdown?.elapsedMs).toBe(900);
  });

  it("returns a clean error byte-identical, marking nothing", () => {
    // The no-match half of the redaction contract: a scrub that rewrote a clean
    // value, or stamped a marker on it, would make every error look handled.
    const error = "Error: ENOENT, open 'update.zip'";

    const sanitized = sanitizedDiagnostics(
      TelemetryCategory.ElectronUpdateFailed,
      { desktopUpdate: { trigger: "updater-error", error, version: "1.2.3" } }
    );

    expect(sanitized?.desktopUpdate?.error).toBe(error);
    expect(sanitized?.desktopUpdate?.version).toBe("1.2.3");
    expect(sanitized?.desktopUpdate?.trigger).toBe(
      DesktopUpdateTrigger.UpdaterError
    );
  });
});

describe("one payload carrying every skewed field (ISS-7488)", () => {
  it("arrives whole when all four measured fields are newer than this build", () => {
    // The shape production actually loses: one desktop ahead of this deploy on
    // more than one diagnostic at once. Before ISS-7488 the first refusal alone
    // discarded the entire event.
    const diagnostics = parseDiagnostics(
      TelemetryCategory.StoreIntegrityFailureDetected,
      {
        tokenCostPricingMiss: {
          model: "gpt-5.6-sol",
          reason: "no_match",
          surface: "surface_from_a_newer_build",
        },
        collectorRecordsDropped: {
          reason: "reason_from_a_newer_build",
          count: 9,
        },
        storeIntegrity: {
          healthy: true,
          durationMs: 3,
          checksRun: ["check_from_a_newer_build"],
          issueCount: 0,
          issues: [],
          truncated: false,
        },
        desktopUpdate: { trigger: "updater-error", error: "z".repeat(900) },
      }
    );

    expect(diagnostics?.tokenCostPricingMiss?.surface).toBe(
      TokenCostPricingMissSurface.Unknown
    );
    expect(diagnostics?.collectorRecordsDropped?.reason).toBe(
      CollectorRecordsDroppedReason.Unknown
    );
    expect(diagnostics?.storeIntegrity?.checksRun).toEqual([
      StoreIntegrityCheckName.Unknown,
    ]);
    expect(diagnostics?.desktopUpdate?.error?.length).toBe(ERROR_MAX_CHARS);
    expect(diagnostics?.collectorRecordsDropped?.count).toBe(9);
    expect(diagnostics?.exitCode).toBe(SIBLING_EXIT_CODE);
  });
});

describe("diagnostics skew posture table (ISS-7488)", () => {
  it("names the branches whose bounded vocabularies all fold", () => {
    // Pinned by name so flipping a branch back to a refusing vocabulary is a
    // visible edit here rather than a silent return of the whole-event drop.
    // `tsc` already forces a row per schema field; this forces the ANSWER to be
    // deliberate.
    const folding = Object.entries(DESKTOP_DIAGNOSTICS_SKEW_POSTURE)
      .filter(([, posture]) => posture === DiagnosticsSkewPosture.FoldsUnknown)
      .map(([field]) => field)
      .sort();

    expect(folding).toEqual([
      "collectorRecordsDropped",
      "desktopUpdate",
      "invocationSyncMissingParents",
      "localReadFailed",
      "outboundNetwork",
      "syncLaneGaveUp",
      "syncLaneReArmed",
      "syncLaneStall",
    ]);
  });
});
