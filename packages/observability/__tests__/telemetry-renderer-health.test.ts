/**
 * @file telemetry-renderer-health.test.ts
 * @description ISS-6331 — the `rendererHealth` diagnostics must survive BOTH
 * server boundaries a desktop renderer-health event crosses before it is logged:
 *
 *   1. `desktopTelemetryEventSchema` — the wire validator. The top-level
 *      diagnostics object strips unknown keys, and an unknown ENUM value drops
 *      the whole event as `telemetry.validation_failed`, so a producer-only
 *      `source` would make the signal vanish entirely rather than lose a field.
 *   2. `sanitizeDesktopTelemetryDiagnostics` — the redaction pass
 *      `handleTelemetryEvent` runs before logging. `detail` is the only free-text
 *      field on this family and gets the same `sanitizeTextTail` credential
 *      scrub `logTail`/`stderrTail` already get, so a producer-side regression or
 *      a version-skewed desktop build cannot put a credential-shaped line on a
 *      Datadog attribute. The desktop-side sanitizer is the first layer; this is
 *      the second, and the bounded fields around it must survive it untouched.
 */
import { describe, expect, it } from "vitest";
import { sanitizeDesktopTelemetryDiagnostics } from "../telemetry/emitter";
import { RendererLoadFailureSource } from "../telemetry/renderer-load-failure-source";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/** A load failure as the desktop reporter emits it, already path-redacted. */
const VALID_RENDERER_HEALTH = {
  reloadsInWindow: 2,
  source: RendererLoadFailureSource.DidFailLoad,
  errorCode: -6,
  detail: "ERR_FILE_NOT_FOUND [redacted-path]",
} as const;

function eventWith(rendererHealth: unknown, category?: string) {
  return {
    schemaVersion: "1",
    category: category ?? TelemetryCategory.RendererLoadFailed,
    severity: "error",
    timestamp: "2026-08-17T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: "target-1",
    },
    diagnostics: { rendererHealth },
  };
}

function parsedRendererHealth(rendererHealth: unknown) {
  const parsed = desktopTelemetryEventSchema.safeParse(
    eventWith(rendererHealth)
  );
  return parsed.success ? parsed.data.diagnostics?.rendererHealth : undefined;
}

describe("rendererHealth wire schema (ISS-6331)", () => {
  it("carries every field of a load failure through validation", () => {
    expect(parsedRendererHealth(VALID_RENDERER_HEALTH)).toEqual(
      VALID_RENDERER_HEALTH
    );
  });

  it("accepts the two other categories and the preload source", () => {
    for (const category of [
      TelemetryCategory.RendererUnresponsive,
      TelemetryCategory.RendererReloadBudgetExhausted,
    ]) {
      const parsed = desktopTelemetryEventSchema.safeParse(
        eventWith({ reloadsInWindow: 3 }, category)
      );
      expect(parsed.success).toBe(true);
    }
    expect(
      parsedRendererHealth({
        reloadsInWindow: 0,
        source: RendererLoadFailureSource.PreloadError,
      })
    ).toEqual({
      reloadsInWindow: 0,
      source: "preload_error",
    });
  });

  it("drops the whole event on a source value only a producer knows", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      eventWith({ reloadsInWindow: 0, source: "renderer_gone_walkabout" })
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a negative reload count, which the breaker cannot produce", () => {
    expect(parsedRendererHealth({ reloadsInWindow: -1 })).toBeUndefined();
  });
});

describe("rendererHealth server-side redaction (ISS-6331)", () => {
  it("scrubs a credential-shaped line out of detail", () => {
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      rendererHealth: {
        reloadsInWindow: 1,
        source: RendererLoadFailureSource.PreloadError,
        detail:
          "Unable to load preload script\nAuthorization: Bearer sk_live_abcdefghijklmnopqrstuvwxyz",
      },
    });

    const detail = sanitized?.rendererHealth?.detail;
    expect(detail).toBeDefined();
    // Anchored on the surviving diagnosis so this cannot pass by being empty.
    expect(detail).toContain("Unable to load preload script");
    expect(detail).not.toContain("sk_live_abcdefghijklmnopqrstuvwxyz");
  });

  it("leaves a clean detail and every bounded field untouched", () => {
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      rendererHealth: { ...VALID_RENDERER_HEALTH },
    });

    expect(sanitized?.rendererHealth).toEqual(VALID_RENDERER_HEALTH);
  });

  it("passes a detail-less renderer-health payload straight through", () => {
    const sanitized = sanitizeDesktopTelemetryDiagnostics({
      rendererHealth: { reloadsInWindow: 3 },
    });

    expect(sanitized?.rendererHealth).toEqual({ reloadsInWindow: 3 });
  });
});
