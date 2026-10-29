/**
 * ISS-7261: the desktop union `TokenCostPricingMissSurface` names
 * `telemetry/schema` as its mirror, and a member added there and not here used
 * not to degrade at all — the `z.enum` mismatch failed the WHOLE event, so the
 * emitter replaced it with a generic `telemetry.validation_failed` payload and
 * the model, reason, and sessionId were gone. That silence is why the mirror
 * needs a test rather than a comment.
 *
 * ISS-7488 made the field coarsen instead, after that silence was measured in
 * production. The mirror still matters for the same reason — a coarsened surface
 * is the one dimension this event exists to name — but a drifted member now
 * costs precision rather than the payload.
 *
 * Its own file rather than an addition to `telemetry-schema.test.ts`, which is
 * on the shrink-only grandfather list (root AGENTS.md, "File Size and
 * Organization").
 */
import { describe, expect, it } from "vitest";
import {
  desktopTelemetryEventSchema,
  TokenCostPricingMissSurface,
} from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

const PRICING_MISS_EVENT = {
  schemaVersion: "1",
  category: TelemetryCategory.TokenCostPricingMiss,
  severity: "warn",
  timestamp: "2026-08-19T00:00:00.000Z",
  trace: {
    commandId: "cmd-1",
    operationId: "op-1",
    computeTargetId: "target-1",
    gatewaySessionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  },
};

describe("token-cost pricing-miss surface mirror (ISS-7261)", () => {
  it("accepts the per-component-invocation surface and keeps its diagnostics", () => {
    const result = desktopTelemetryEventSchema.safeParse({
      ...PRICING_MISS_EVENT,
      diagnostics: {
        tokenCostPricingMiss: {
          model: "gpt-5.6-sol",
          reason: "no_match",
          surface: "component_invocation",
          sessionId: "sess-7261",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.tokenCostPricingMiss).toEqual({
        model: "gpt-5.6-sol",
        reason: "no_match",
        surface: "component_invocation",
        sessionId: "sess-7261",
      });
    }
  });

  it("accepts every surface the desktop producer emits, as ITSELF", () => {
    const surfaces = [
      "synced_session",
      "sync_resolver",
      "branch_projection",
      "trace_activity",
      "imported_token_costs",
      "component_invocation",
    ] as const;

    for (const surface of surfaces) {
      const result = desktopTelemetryEventSchema.safeParse({
        ...PRICING_MISS_EVENT,
        diagnostics: {
          tokenCostPricingMiss: {
            model: "gpt-5.6-sol",
            reason: "no_match",
            surface,
          },
        },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.diagnostics?.tokenCostPricingMiss?.surface).toBe(
          surface
        );
      }
    }
  });

  it("folds a surface no producer emits, rather than widening to any string", () => {
    // ISS-7488 CHANGED THIS EXPECTATION. It asserted rejection, as the negative
    // sibling proving the enum was genuinely closed. Rejection was the defect:
    // it sank the WHOLE event, and 15 of the 33 desktop telemetry payloads
    // refused over the 30 days to 2026-09-14 failed on this one field. The
    // vocabulary is STILL bounded — that is what this case now pins, since
    // widening the field to `z.string()` would let an old build mint unbounded
    // Datadog tag values — but an unrecognised member lands on `Unknown` and the
    // model, reason and session id arrive with it.
    const result = desktopTelemetryEventSchema.safeParse({
      ...PRICING_MISS_EVENT,
      diagnostics: {
        tokenCostPricingMiss: {
          model: "gpt-5.6-sol",
          reason: "no_match",
          surface: "not_a_real_surface",
        },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.diagnostics?.tokenCostPricingMiss).toEqual({
        model: "gpt-5.6-sol",
        reason: "no_match",
        surface: TokenCostPricingMissSurface.Unknown,
      });
    }
  });
});
