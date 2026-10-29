/**
 * @file telemetry-distribution-install-gave-up.test.ts
 * @description ISS-6170 — the `distributionInstallGaveUp` diagnostics must
 * survive `desktopTelemetryEventSchema`, because the alert on this category is
 * routed by `reason`: `ENOTFOUND` means "this build's catalog is behind what the
 * org distributes" (remedy: update Desktop) while `ENOCOMMAND` means "this pack
 * has no install command" (remedy: fix the catalog entry).
 *
 * Two distinct ways that silently breaks, and this file pins both:
 *
 *   1. The top-level diagnostics object STRIPS unknown keys, so a field the
 *      desktop emits but this schema does not declare is dropped without any
 *      parse error — the event arrives, the monitor's group-by is simply empty.
 *   2. The `reason` enum is a HAND-HELD mirror of `StreamRunErrorCode` in
 *      `apps/desktop/src/shared/install-run-contract.ts` (this package cannot
 *      import `apps/desktop`). A code only the producer knows about does not
 *      degrade to an unknown value: it makes this schema reject the WHOLE event
 *      as `telemetry.validation_failed`, and again on every retry.
 *
 * The usual gate for (2), `scripts/lint/rules/no-unmirrored-desktop-telemetry-enum.ts`,
 * is structurally blind to this pair — it scans `apps/desktop/src/main/telemetry/`
 * and `.../database/`, and `StreamRunErrorCode` lives in `apps/desktop/src/shared/`
 * because the boot path needs it import-free. So this file and its desktop-side
 * sibling in `apps/desktop/test/required-plugin-installer-terminal-latch.test.ts`
 * are the guard, each pinning the same vocabulary as INDEPENDENT literals.
 *
 * Lives beside `telemetry-schema.test.ts` rather than in it: that file is
 * grandfathered by `noExcessiveLinesPerFile` and the shrink-only rule forbids
 * growing it, and a per-concern sibling is the shape the neighbouring
 * `telemetry-harness-result-envelopes-dropped.test.ts` already uses.
 */
import { describe, expect, it } from "vitest";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/**
 * Every member of the desktop producer's `StreamRunErrorCode`, spelled out as
 * literals rather than imported or derived. The duplication IS the test: a list
 * read back off the schema under test would agree with it by construction and
 * could never report the drift it exists to catch.
 */
const PRODUCER_CODES = [
  "ENOTFOUND",
  "ENOCOMMAND",
  "ENOCLI",
  "EBADCWD",
  "EINFLIGHT",
  "ECWDREQUIRED",
];

function eventWith(reason: string) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.DistributionInstallGaveUp,
    severity: "error",
    timestamp: "2026-08-24T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { distributionInstallGaveUp: { reason } },
  };
}

describe("distributionInstallGaveUp diagnostics (ISS-6170)", () => {
  it("accepts every producer code and keeps the reason through the parse", () => {
    for (const reason of PRODUCER_CODES) {
      const result = desktopTelemetryEventSchema.safeParse(eventWith(reason));

      expect(result.success).toBe(true);
      // Asserting the parsed OUTPUT, not just `success`: an undeclared field is
      // stripped rather than rejected, so a success check alone would stay green
      // on exactly the defect that empties the monitor's group-by.
      if (result.success) {
        expect(result.data.diagnostics?.distributionInstallGaveUp).toEqual({
          reason,
        });
      }
    }
  });

  it("rejects a reason outside the producer's closed vocabulary", () => {
    // The control for the case above: widening the enum to `z.string()` would
    // satisfy every assertion there while handing the alert an unbounded
    // group-by, and would stop catching producer drift altogether.
    const result = desktopTelemetryEventSchema.safeParse(eventWith("EMADEUP"));

    expect(result.success).toBe(false);
  });

  it("strips an unknown sibling key without dropping the give-up reason", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...eventWith("ENOTFOUND"),
      diagnostics: {
        distributionInstallGaveUp: {
          reason: "ENOTFOUND",
          packId: "cl-sweep",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      // The pack id is cloud-supplied content and deliberately stays out of the
      // wire record; it must be dropped WITHOUT taking the reason with it.
      expect(result.data.diagnostics?.distributionInstallGaveUp).toEqual({
        reason: "ENOTFOUND",
      });
    }
  });
});
