import { log } from "@repo/observability/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTelemetryEvent } from "@/lib/desktop-telemetry-handler";
import {
  defaultHandlerContext,
  VALID_UUID_A,
  VALID_UUID_B,
  validDesktopWirePayload,
} from "./utils/desktop-telemetry-fixtures";

/**
 * ISS-9759 — `trace.loopSessionId` survives the ingest boundary and reaches the
 * emitted log.
 *
 * WHY THIS IS A HANDLER TEST AND NOT ONLY A SCHEMA TEST. The desktop emits
 * `trace.loopSessionId` (its own `TelemetryTraceContext` in
 * apps/desktop/src/main/telemetry/telemetry-protocol.ts declares that key and no
 * `sessionId`). The wire schema admitted only `sessionId`, so Zod STRIPPED the
 * key and the transform then rewrote it to `undefined`: the value never reached
 * the cloud and nothing errored on either side. The in-process producer path
 * skips this boundary schema entirely, which is why no desktop test observed it
 * — the defect was only visible where the payload actually crosses.
 *
 * So this asserts the CLOUD-SIDE END of that crossing: the id the handler puts
 * on the log record Datadog receives, after the real parse, the real
 * `buildTelemetryTraceContext` enrichment and the real redaction. A schema-level
 * round trip (covered in `@repo/observability`'s `telemetry-schema.test.ts`)
 * proves the parse; this proves the production wiring downstream of it, so
 * deleting the field from the emitted trace cannot leave the suite green.
 *
 * The `sessionId` case is the version-skew half: builds already in the field
 * send the older spelling, and it must keep correlating rather than start being
 * rejected.
 */

describe("desktop telemetry loop session id (ISS-9759)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits trace.loopSessionId when the desktop sends that key", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    const result = handleTelemetryEvent(
      {
        ...validDesktopWirePayload,
        trace: {
          commandId: "cmd-1",
          operationId: "op-1",
          computeTargetId: validDesktopWirePayload.trace.computeTargetId,
          gatewaySessionId: VALID_UUID_A,
          loopSessionId: VALID_UUID_B,
        },
      },
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);
    expect(traceOf(infoSpy).loopSessionId).toBe(VALID_UUID_B);
  });

  it("still emits trace.loopSessionId for an older build sending sessionId", () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});

    // `validDesktopWirePayload.trace` carries `sessionId`, the shape installed
    // builds already send. Accepting it is the compatibility half; mapping it is
    // what keeps those builds correlating rather than merely not-rejected.
    const result = handleTelemetryEvent(
      validDesktopWirePayload,
      defaultHandlerContext
    );

    expect(result.ok).toBe(true);
    expect(traceOf(infoSpy).loopSessionId).toBe(VALID_UUID_B);
  });
});

/** The narrow slice of the spy this reader needs. */
type LogInfoSpy = { mock: { calls: unknown[][] } };

/**
 * The `trace` the handler put on the emitted telemetry log record.
 *
 * THROWS rather than asserting, for two reasons: an assertion outside `it()`
 * is `noMisplacedAssertion`, and a reader that returned `undefined` for a
 * missing log would turn every caller's `toBe` into a message about
 * `undefined` rather than about the record never being emitted.
 */
function traceOf(infoSpy: LogInfoSpy): Record<string, unknown> {
  const call = infoSpy.mock.calls.find(
    (args) => args[0] === "Desktop telemetry event received"
  );
  if (call === undefined) {
    throw new Error(
      'The handler emitted no "Desktop telemetry event received" log, so there is no trace to read a loop session id from.'
    );
  }
  return (call[1] as { trace: Record<string, unknown> }).trace;
}
