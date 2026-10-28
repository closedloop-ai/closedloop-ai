/**
 * Unit tests for TelemetryService (T-6.1)
 *
 * Covers:
 * - emit() calls sendTelemetry with correct structure
 * - emit() never throws even if callback throws
 * - setTargetId() injects into trace.computeTargetId
 * - large logTail fields are truncated to TELEMETRY_MAX_FIELD_BYTES
 * - large stderrTail fields are truncated to TELEMETRY_MAX_FIELD_BYTES
 * - sendTelemetry callback never called (disconnected relay simulation) does not throw
 *
 * stripAnsi() (imported directly from diagnostics-helpers.ts):
 * - removes standard ANSI escape sequences
 * - passes through clean text unchanged
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { stripAnsi } from "../src/main/diagnostics/diagnostics-helpers.js";
import {
  TELEMETRY_MAX_FIELD_BYTES,
  type TelemetryEventPayload,
} from "../src/main/telemetry/telemetry-protocol.js";
import {
  type EnrichedTelemetryEvent,
  TelemetryService,
} from "../src/main/telemetry/telemetry-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Gateway session ids are UUIDs on the wire (whitlockk, #5732 review). The cloud
 * ingress validates them as `z.union([z.uuid(), /^[0-9a-f]{12}$/])` —
 * `gatewaySessionIdSchema` in `packages/observability/telemetry/schema.ts`, the
 * second arm being the redaction hash. `TelemetryService` itself does no
 * validation, so a `gw-*` placeholder passes here while being a shape no real
 * event could carry; the precedence contract below is worth pinning against a
 * value that could actually traverse the boundary.
 *
 * Not imported from the schema: `apps/desktop` does not depend on
 * `@repo/observability`, and adding that dependency to satisfy a fixture would
 * be a worse trade than restating the constraint here.
 */
const SERVICE_GATEWAY_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CALLER_GATEWAY_SESSION_ID = "22222222-2222-4222-8222-222222222222";

function makeEvent(
  overrides: Partial<TelemetryEventPayload> = {}
): TelemetryEventPayload {
  return {
    severity: "info",
    category: "queue.stats_changed",
    message: "test event",
    ...overrides,
  } as TelemetryEventPayload;
}

// ---------------------------------------------------------------------------
// TelemetryService.emit()
// ---------------------------------------------------------------------------

describe("TelemetryService.emit()", () => {
  test("calls sendTelemetry with a correctly structured event", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    const event = makeEvent({
      message: "hello",
      category: "queue.stats_changed",
    });
    svc.emit(event);

    assert.equal(received.length, 1);
    assert.equal(received[0].message, "hello");
    assert.equal(received[0].category, "queue.stats_changed");
    assert.equal(received[0].severity, "info");
    assert.equal(received[0].schemaVersion, "1");
    assert.equal(typeof received[0].timestamp, "string");
    assert.ok(received[0].timestamp!.length > 0);
  });

  test("never throws even if sendTelemetry callback throws", () => {
    const svc = new TelemetryService({
      sendTelemetry: () => {
        throw new Error("callback error");
      },
    });

    // Should not throw
    assert.doesNotThrow(() => {
      svc.emit(makeEvent());
    });
  });

  test("never throws even when sendTelemetry callback throws (relay error simulation)", () => {
    // Simulate a relay error by using a callback that throws on invocation
    let callbackInvoked = false;
    const svc = new TelemetryService({
      sendTelemetry: () => {
        callbackInvoked = true;
        // This represents a relay that is disconnected - the callback could
        // throw a connection error
        throw new Error("relay disconnected");
      },
    });

    // Even though the callback throws (simulating disconnected relay), emit() must not throw
    assert.doesNotThrow(() => {
      svc.emit(makeEvent());
    });

    // The callback was invoked (emit tried to send) but the error was swallowed
    assert.equal(callbackInvoked, true);
  });
});

// ---------------------------------------------------------------------------
// TelemetryService.setTargetId()
// ---------------------------------------------------------------------------

describe("TelemetryService.setTargetId()", () => {
  test("injects computeTargetId into trace context of emitted event", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    svc.setTargetId("target-abc-123");
    svc.emit(makeEvent({ message: "after setTargetId" }));

    assert.equal(received.length, 1);
    assert.equal(received[0].trace?.computeTargetId, "target-abc-123");
  });

  test("merges computeTargetId with existing trace fields", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    svc.setTargetId("target-xyz");
    svc.emit(
      makeEvent({
        trace: { commandId: "cmd-1", gatewaySessionId: "gw-1" },
      })
    );

    assert.equal(received.length, 1);
    assert.equal(received[0].trace?.computeTargetId, "target-xyz");
    assert.equal(received[0].trace?.commandId, "cmd-1");
    assert.equal(received[0].trace?.gatewaySessionId, "gw-1");
  });

  test("does not inject computeTargetId before setTargetId is called", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    svc.emit(makeEvent());

    assert.equal(received.length, 1);
    assert.equal(received[0].trace?.computeTargetId, "");
  });
});

// ---------------------------------------------------------------------------
// ISS-7488 — required trace fields survive a caller's absent values
// ---------------------------------------------------------------------------

describe("TelemetryService required trace defaults (ISS-7488)", () => {
  test("keeps commandId and operationId as strings when the caller forwards absent values", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    // Every member of TelemetryTraceContext is optional, and producers forward
    // their own optional args straight through — so the keys arrive PRESENT holding undefined.
    svc.emit(
      makeEvent({
        trace: {
          commandId: undefined,
          operationId: undefined,
          gatewaySessionId: "gw-9",
        },
      })
    );

    assert.equal(received.length, 1);
    const trace = received[0].trace;
    // The cloud schema types these `z.string()`, so an undefined here rejects
    // the WHOLE event as telemetry.validation_failed.
    assert.equal(trace?.commandId, "");
    assert.equal(trace?.operationId, "");
    assert.equal(trace?.gatewaySessionId, "gw-9");
    assert.equal(typeof trace?.commandId, "string");
    assert.equal(typeof trace?.operationId, "string");
  });

  test("falls back to the service target id when the caller forwards an absent computeTargetId", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    svc.setTargetId("target-abc-123");
    svc.emit(makeEvent({ trace: { computeTargetId: undefined } }));

    assert.equal(received.length, 1);
    assert.equal(received[0].trace?.computeTargetId, "target-abc-123");
  });

  test("omits gatewaySessionId entirely when none is known", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    svc.emit(makeEvent({ trace: { commandId: "cmd-1" } }));

    assert.equal(received.length, 1);
    // Absent optional cross-process fields stay omitted, never an explicit
    // undefined key (root AGENTS.md, Cross-Repo Compatibility).
    assert.equal(
      Object.hasOwn(received[0].trace ?? {}, "gatewaySessionId"),
      false
    );
  });

  test("omits gatewaySessionId when the caller FORWARDS an absent one", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    // The case above proves nothing on its own: with no `gatewaySessionId` key
    // in the input there is none in the output whether or not the conditional
    // exists. THIS is the shape this ticket is about — a caller forwarding its
    // own optional arg puts the key on the object holding `undefined`, and a
    // conditional spread after `...trace` can add a key but cannot remove one.
    svc.emit(
      makeEvent({ trace: { commandId: "cmd-1", gatewaySessionId: undefined } })
    );

    assert.equal(received.length, 1);
    assert.equal(
      Object.hasOwn(received[0].trace ?? {}, "gatewaySessionId"),
      false
    );
  });

  test("injects the service gatewaySessionId when the caller has none", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    // The other half of the conditional, and previously uncovered: deleting the
    // whole branch left all 36 tests green.
    svc.setGatewaySessionId(SERVICE_GATEWAY_SESSION_ID);
    svc.emit(
      makeEvent({ trace: { commandId: "cmd-1", gatewaySessionId: undefined } })
    );

    assert.equal(received.length, 1);
    assert.equal(
      received[0].trace?.gatewaySessionId,
      SERVICE_GATEWAY_SESSION_ID
    );
  });

  test("the SERVICE gatewaySessionId wins over a caller-supplied one", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    svc.setGatewaySessionId(SERVICE_GATEWAY_SESSION_ID);
    svc.emit(
      makeEvent({ trace: { gatewaySessionId: CALLER_GATEWAY_SESSION_ID } })
    );

    assert.equal(received.length, 1);
    // Deliberately the opposite precedence from `commandId`/`operationId`, and
    // pinned here because nothing else states it. The gateway session (like
    // `computeTargetId`) identifies THIS process, so a caller cannot claim to be
    // emitting from a different one; the required-field defaults above only fill
    // a gap the caller left. Enforced upstream in `enrichEvent`, where the
    // service values spread AFTER `event.trace`.
    assert.equal(
      received[0].trace?.gatewaySessionId,
      SERVICE_GATEWAY_SESSION_ID
    );
  });

  test("a caller-supplied commandId still wins over the default", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    svc.emit(makeEvent({ trace: { commandId: "cmd-real" } }));

    assert.equal(received.length, 1);
    assert.equal(received[0].trace?.commandId, "cmd-real");
  });
});

// ---------------------------------------------------------------------------
// logTail truncation
// ---------------------------------------------------------------------------

describe("TelemetryService logTail truncation", () => {
  test("truncates logTail larger than TELEMETRY_MAX_FIELD_BYTES", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    // Build a logTail that is clearly over the 4 KiB limit
    const overLimit = "x".repeat(TELEMETRY_MAX_FIELD_BYTES + 500);
    svc.emit(
      makeEvent({
        diagnostics: { logTail: overLimit },
      })
    );

    assert.equal(received.length, 1);
    const logTail = received[0].diagnostics?.logTail;
    assert.ok(logTail !== undefined, "logTail should be present");
    const byteLength = Buffer.byteLength(logTail, "utf8");
    assert.ok(
      byteLength <= TELEMETRY_MAX_FIELD_BYTES,
      `logTail byte length ${byteLength} exceeds TELEMETRY_MAX_FIELD_BYTES ${TELEMETRY_MAX_FIELD_BYTES}`
    );
  });

  test("passes through logTail smaller than TELEMETRY_MAX_FIELD_BYTES unchanged", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    const shortTail = "short log line\n";
    svc.emit(
      makeEvent({
        diagnostics: { logTail: shortTail },
      })
    );

    assert.equal(received.length, 1);
    assert.equal(received[0].diagnostics?.logTail, shortTail);
  });

  test("preserves other diagnostics fields when truncating logTail", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    const overLimit = "y".repeat(TELEMETRY_MAX_FIELD_BYTES + 100);
    svc.emit(
      makeEvent({
        diagnostics: {
          logTail: overLimit,
          errorStack: "Error: something\n  at fn (file.ts:1)",
          extra: { key: "value" },
        },
      })
    );

    assert.equal(received.length, 1);
    assert.equal(
      received[0].diagnostics?.errorStack,
      "Error: something\n  at fn (file.ts:1)"
    );
    assert.deepEqual(received[0].diagnostics?.extra, { key: "value" });
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// stderrTail truncation
// ---------------------------------------------------------------------------

describe("TelemetryService stderrTail truncation", () => {
  test("truncates stderrTail larger than TELEMETRY_MAX_FIELD_BYTES", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    const overLimit = "e".repeat(TELEMETRY_MAX_FIELD_BYTES + 500);
    svc.emit(
      makeEvent({
        diagnostics: { stderrTail: overLimit },
      })
    );

    assert.equal(received.length, 1);
    const stderrTail = received[0].diagnostics?.stderrTail;
    assert.ok(stderrTail !== undefined, "stderrTail should be present");
    const byteLength = Buffer.byteLength(stderrTail, "utf8");
    assert.ok(
      byteLength <= TELEMETRY_MAX_FIELD_BYTES,
      `stderrTail byte length ${byteLength} exceeds TELEMETRY_MAX_FIELD_BYTES ${TELEMETRY_MAX_FIELD_BYTES}`
    );
  });

  test("passes through stderrTail smaller than TELEMETRY_MAX_FIELD_BYTES unchanged", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    const shortTail = "short stderr line\n";
    svc.emit(
      makeEvent({
        diagnostics: { stderrTail: shortTail },
      })
    );

    assert.equal(received.length, 1);
    assert.equal(received[0].diagnostics?.stderrTail, shortTail);
  });

  test("truncates both logTail and stderrTail independently", () => {
    const received: EnrichedTelemetryEvent[] = [];
    const svc = new TelemetryService({
      sendTelemetry: (evt) => received.push(evt),
    });

    const overLog = "L".repeat(TELEMETRY_MAX_FIELD_BYTES + 200);
    const overStderr = "S".repeat(TELEMETRY_MAX_FIELD_BYTES + 300);
    svc.emit(
      makeEvent({
        diagnostics: { logTail: overLog, stderrTail: overStderr },
      })
    );

    assert.equal(received.length, 1);
    const logBytes = Buffer.byteLength(
      received[0].diagnostics!.logTail!,
      "utf8"
    );
    const stderrBytes = Buffer.byteLength(
      received[0].diagnostics!.stderrTail!,
      "utf8"
    );
    assert.ok(
      logBytes <= TELEMETRY_MAX_FIELD_BYTES,
      "logTail should be truncated"
    );
    assert.ok(
      stderrBytes <= TELEMETRY_MAX_FIELD_BYTES,
      "stderrTail should be truncated"
    );
  });
});

// ---------------------------------------------------------------------------
// stripAnsi()
// ---------------------------------------------------------------------------

describe("stripAnsi()", () => {
  test("removes standard color codes", () => {
    const colored = "\u001b[31mError:\u001b[0m something failed";
    assert.equal(stripAnsi(colored), "Error: something failed");
  });

  test("removes bold/underline sequences", () => {
    const styled = "\u001b[1mBold\u001b[22m and \u001b[4munderline\u001b[24m";
    assert.equal(stripAnsi(styled), "Bold and underline");
  });

  test("removes cursor movement sequences", () => {
    const cursor = "\u001b[2Amoved up\u001b[Bmoved down";
    assert.equal(stripAnsi(cursor), "moved upmoved down");
  });

  test("passes through clean text unchanged", () => {
    const clean = "No ANSI here, just plain text 123!";
    assert.equal(stripAnsi(clean), clean);
  });

  test("handles empty string", () => {
    assert.equal(stripAnsi(""), "");
  });

  test("handles multiple sequences in one line", () => {
    const multi =
      "\u001b[32m[\u001b[1mINFO\u001b[22m]\u001b[0m Starting process";
    assert.equal(stripAnsi(multi), "[INFO] Starting process");
  });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
