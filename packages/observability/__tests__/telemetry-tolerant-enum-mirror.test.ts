/**
 * @file telemetry-tolerant-enum-mirror.test.ts
 * @description ISS-7296 — producer-only members of a TOLERANT desktop telemetry
 * enum must survive ingest as themselves.
 *
 * `tolerantDesktopTelemetryValue` maps an unrecognised string onto the enum's
 * own `Unknown` member before `z.enum` runs, so a member the desktop producer
 * emits and the ingest const does not list is COARSENED rather than dropped:
 * the event arrives, but the one field an operator would act on reads `unknown`
 * and is indistinguishable from every other failure of the same shape. That
 * tolerance is deliberate and load-bearing for version skew — it must keep
 * working for a member only a NEWER desktop knows — which is exactly why an
 * in-tree member reaching it silently is a defect and not skew.
 *
 * Each case deliberately feeds the RAW STRING the desktop producer emits rather
 * than the ingest const, and pins the const against it separately. `apps/desktop`
 * does not depend on this package — it mirrors these values as a bare string
 * union — so a case written entirely against the const would move in lockstep
 * with any edit to it and stay green while the two halves drifted apart.
 */
import { describe, expect, it } from "vitest";
import {
  DesktopShutdownTrigger,
  SupportUploadReason,
} from "../telemetry/desktop-lifecycle-triggers";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

function eventWith(category: string, diagnostics: unknown) {
  return {
    schemaVersion: "1",
    category,
    severity: "error",
    timestamp: "2026-08-19T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics,
  };
}

describe("tolerant desktop telemetry enums (ISS-7296)", () => {
  it("a missing support-upload token survives ingest as itself, not as `unknown`", () => {
    // Desktop builds older than ISS-12435 send this exact literal when their
    // loop token store is empty. It is the one support-upload failure
    // with an obvious operator remedy (provision the token), so coarsening it
    // into `unknown` hides the only actionable member behind twelve that are not.
    const desktopEmittedReason = "missing_token";
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(TelemetryCategory.DesktopSupportUpload, {
        supportUpload: { outcome: "failed", reason: desktopEmittedReason },
      })
    );

    expect(parsed.success).toBe(true);
    const reason = parsed.success
      ? parsed.data.diagnostics?.supportUpload?.reason
      : undefined;
    expect(reason).toBe(desktopEmittedReason);
    expect(SupportUploadReason.MissingToken).toBe(desktopEmittedReason);
  });

  it("a failed update install survives ingest as its own shutdown trigger", () => {
    // apps/desktop/src/main/lifecycle/shutdown-lifecycle.ts emits this literal.
    // It is the one shutdown trigger that names a FAILED UPDATE as the cause, so
    // coarsening it makes an update-install regression read as an ordinary quit.
    const desktopEmittedTrigger = "update-install-failed";
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith(TelemetryCategory.DesktopShutdownFailed, {
        desktopShutdown: { trigger: desktopEmittedTrigger },
      })
    );

    expect(parsed.success).toBe(true);
    const trigger = parsed.success
      ? parsed.data.diagnostics?.desktopShutdown?.trigger
      : undefined;
    expect(trigger).toBe(desktopEmittedTrigger);
    expect(DesktopShutdownTrigger.UpdateInstallFailed).toBe(
      desktopEmittedTrigger
    );
  });
});
