/**
 * @file desktop-telemetry-renderer-health.test.ts
 * @description ISS-6331 — the wire boundary for the renderer-health signals.
 *
 * `desktopTelemetryEventSchema` STRIPS unknown `diagnostics` keys and rejects an
 * unknown enum value by dropping the WHOLE event as `telemetry.validation_failed`.
 * Either failure is silent from the desktop side, whose own tests pass through
 * the in-process path and never see this schema — so the producer's payload gets
 * asserted here, at the boundary it actually has to survive.
 */
import { log } from "@repo/observability/log";
import { RendererLoadFailureSource } from "@repo/observability/telemetry/renderer-load-failure-source";
import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTelemetryEvent,
  type TelemetryHandlerContext,
} from "@/lib/desktop-telemetry-handler";

const COMPUTE_TARGET_ID = "target-test-iss6331";

const context: TelemetryHandlerContext = {
  authenticatedTargetId: COMPUTE_TARGET_ID,
};

type LoggedTelemetry = {
  category: string;
  diagnostics?: {
    rendererHealth?: {
      reloadsInWindow?: number;
      source?: string;
      errorCode?: number;
      detail?: string;
    };
  };
};

function rendererHealthEvent(category: string, rendererHealth: unknown) {
  return {
    schemaVersion: "1",
    category,
    severity: "error",
    timestamp: "2026-08-17T00:00:00.000Z",
    trace: {
      commandId: "",
      operationId: "",
      computeTargetId: COMPUTE_TARGET_ID,
    },
    diagnostics: { rendererHealth },
  };
}

function loggedFrom(infoSpy: ReturnType<typeof vi.spyOn>): LoggedTelemetry {
  return infoSpy.mock.calls[0]?.[1] as LoggedTelemetry;
}

describe("handleTelemetryEvent — renderer health (ISS-6331)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards a load failure's typed rendererHealth diagnostics", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      rendererHealthEvent(TelemetryCategory.RendererLoadFailed, {
        reloadsInWindow: 2,
        source: RendererLoadFailureSource.DidFailLoad,
        errorCode: -6,
        detail: "ERR_FILE_NOT_FOUND [redacted-path]",
      }),
      context
    );

    expect(result.ok).toBe(true);
    const logged = loggedFrom(infoSpy);
    expect(logged.category).toBe("desktop.renderer.load_failed");
    // The whole point: none of these may be stripped on the way through.
    expect(logged.diagnostics?.rendererHealth).toEqual({
      reloadsInWindow: 2,
      source: "did_fail_load",
      errorCode: -6,
      detail: "ERR_FILE_NOT_FOUND [redacted-path]",
    });
  });

  it("accepts the preload-error source and the unresponsive category", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    expect(
      handleTelemetryEvent(
        rendererHealthEvent(TelemetryCategory.RendererUnresponsive, {
          reloadsInWindow: 0,
        }),
        context
      ).ok
    ).toBe(true);
    expect(loggedFrom(infoSpy).category).toBe("desktop.renderer.unresponsive");

    expect(
      handleTelemetryEvent(
        rendererHealthEvent(TelemetryCategory.RendererLoadFailed, {
          reloadsInWindow: 1,
          source: RendererLoadFailureSource.PreloadError,
          detail: "Unable to load preload script: [redacted-path]",
        }),
        context
      ).ok
    ).toBe(true);
  });

  it("carries the exhausted reload count on the give-up category", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      rendererHealthEvent(TelemetryCategory.RendererReloadBudgetExhausted, {
        reloadsInWindow: 3,
      }),
      context
    );

    expect(result.ok).toBe(true);
    const logged = loggedFrom(infoSpy);
    expect(logged.category).toBe("desktop.renderer.reload_budget_exhausted");
    expect(logged.diagnostics?.rendererHealth?.reloadsInWindow).toBe(3);
  });

  it("rejects a source value the wire enum does not know", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    // A producer-only enum value does not lose one field — it drops the whole
    // event. This is the failure mode the mirrored const object prevents.
    const result = handleTelemetryEvent(
      rendererHealthEvent(TelemetryCategory.RendererLoadFailed, {
        reloadsInWindow: 0,
        source: "renderer_gone_walkabout",
      }),
      context
    );

    expect(result.ok).toBe(false);
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
