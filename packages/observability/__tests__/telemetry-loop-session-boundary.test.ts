/**
 * ISS-9759 — `trace.loopSessionId` has to SURVIVE ingest.
 *
 * The desktop emits `trace.loopSessionId`: its own `TelemetryTraceContext`
 * (apps/desktop/src/main/telemetry/telemetry-protocol.ts) declares that key and
 * no `sessionId`, and four job-lifecycle emitters thread a loop session id into
 * it. `desktopTelemetryEventInputSchema.trace` is a plain `z.object`, so Zod's
 * default `.strip` dropped the key it did not declare and the transform then
 * rewrote it to `undefined` — the id never reached the cloud, and nothing
 * errored on either side. The in-process producer path skips this schema
 * entirely, which is why both repos' own tests stayed green over it.
 *
 * These assertions are that boundary. They live beside
 * `telemetry-build-identity.test.ts`, which pins the same failure mode for the
 * build commit, rather than in `telemetry-schema.test.ts`: that file is on the
 * shrink-only `noExcessiveLinesPerFile` grandfather list in biome.jsonc and must
 * never grow.
 */

import { describe, expect, it } from "vitest";
import { desktopTelemetryEventSchema } from "../telemetry/schema";
import { TelemetryCategory } from "../telemetry/telemetry-category";

/**
 * Pinned here rather than read off the module under test: a fixture that
 * derived its expectation from the schema would survive that schema being
 * emptied.
 */
const GATEWAY_SESSION_ID = "166e7770-fd87-49aa-a09b-a91cd2c404c8";
const LOOP_SESSION_ID = "85c4e16f-43d1-4422-b017-e9a2b7073c15";
const OLDER_SPELLING_SESSION_ID = "019d271f-12d1-73ae-924b-479c5f3f2395";

/** A desktop wire event carrying exactly the trace keys a case is about. */
function desktopWireEvent(trace: Record<string, unknown>) {
  return {
    schemaVersion: "1",
    category: TelemetryCategory.JobStarted,
    severity: "info",
    timestamp: "2026-09-08T00:00:00.000Z",
    trace: {
      commandId: "cmd-1",
      operationId: "op-1",
      computeTargetId: "019d271f-12d1-73ae-924b-479c5f3f2395",
      gatewaySessionId: GATEWAY_SESSION_ID,
      ...trace,
    },
  };
}

describe("loop session id survives telemetry ingest (ISS-9759)", () => {
  it("carries the loopSessionId the desktop actually emits", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({ loopSessionId: LOOP_SESSION_ID })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.trace.loopSessionId).toBe(
      LOOP_SESSION_ID
    );
  });

  it("still maps an older build's sessionId onto loopSessionId", () => {
    // The version-skew half. Builds already installed send the older spelling,
    // so it stays accepted AND keeps correlating — a boundary that admitted the
    // payload while dropping the id would satisfy acceptance alone.
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({ sessionId: OLDER_SPELLING_SESSION_ID })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.trace.loopSessionId).toBe(
      OLDER_SPELLING_SESSION_ID
    );
  });

  it("drops a malformed loopSessionId without rejecting the event", () => {
    // The failure MODE, not just the happy path. Declaring this key made a
    // malformed value newly capable of rejecting the entire event, where the
    // undeclared key had merely been stripped — so the whole job-lifecycle span
    // would vanish over one bad dimension. The desktop reads this id out of a
    // file and never validates it, so a truncated write is reachable. Only the
    // dimension is discarded; the span still records.
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({ loopSessionId: "not-a-uuid" })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.trace.loopSessionId).toBeUndefined();
    // The rest of the span is intact, which is the point of failing soft.
    expect(parsed.success && parsed.data.trace.commandId).toBe("cmd-1");
  });

  it("falls back to sessionId when loopSessionId is malformed", () => {
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({
        loopSessionId: "not-a-uuid",
        sessionId: OLDER_SPELLING_SESSION_ID,
      })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.trace.loopSessionId).toBe(
      OLDER_SPELLING_SESSION_ID
    );
  });

  it("prefers loopSessionId when a payload carries both spellings", () => {
    // Reachable only from a build sending each. Pinned so the precedence is a
    // decision rather than an accident of destructuring order.
    const parsed = desktopTelemetryEventSchema.safeParse(
      desktopWireEvent({
        loopSessionId: LOOP_SESSION_ID,
        sessionId: OLDER_SPELLING_SESSION_ID,
      })
    );

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.trace.loopSessionId).toBe(
      LOOP_SESSION_ID
    );
  });
});
