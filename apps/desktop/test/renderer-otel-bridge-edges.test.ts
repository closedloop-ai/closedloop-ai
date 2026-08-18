/**
 * @file renderer-otel-bridge-edges.test.ts
 * @description ISS-5302 — the renderer OTel bridge edge arms, plus the owning
 * suite for `src/shared/renderer-otel-bridge-utils.ts`.
 *
 * These scenarios belong with `renderer-otel-bridge.test.ts` and were written
 * there first; that file measured 1394 logical lines with them, over the 1,000
 * line ceiling in the root AGENTS.md, so they live in this sibling instead. The
 * split is by subject: the parent file owns the happy path, the identity/status
 * contract and the IPC handler; this file owns the optional-field carry-through,
 * the reject arms for unsafe timestamps and scopes, graceful degradation on
 * unserializable input, and the shared normalization helpers the main and
 * renderer OTel runtimes both build records with.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import {
  SpanKind as OTelSpanKind,
  SpanStatusCode as OTelSpanStatusCode,
} from "@opentelemetry/api";
import { parseRendererOtelBridgePayload } from "../src/shared/renderer-otel-bridge.js";
import {
  DesktopOtelSignal,
  RENDERER_OTEL_MAX_ATTRIBUTES_PER_RECORD,
  RENDERER_OTEL_MAX_STRING_BYTES,
  RendererOtelAllowedAttributeKey,
  type RendererOtelBridgePayload,
  RendererOtelExportFailureReason,
} from "../src/shared/renderer-otel-bridge-constants.js";
import {
  hasSpanIdentity,
  hrTimeToUnixNanoString,
  isTerminalRendererOtelResult,
  normalizeAttributes,
  normalizeInstrumentationScope,
  normalizeSpanKind,
  normalizeSpanStatus,
} from "../src/shared/renderer-otel-bridge-utils.js";
import {
  expectExceptionRecord,
  expectGenericRecord,
} from "./renderer-otel-bridge-test-fixtures.js";

test("preserves timestamps, dropped counters, and nameless records", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Metric,
        timestampUnixNano: "1700000000000000000",
        value: 5,
        droppedAttributesCount: 2,
        droppedEventsCount: 3,
        droppedLinksCount: 4,
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const record = expectGenericRecord(parsed.payload.records, 0);
    assert.deepEqual(record, payload.records[0]);
    assert.equal(
      "name" in record,
      false,
      "an absent name is omitted, never emitted as an empty string"
    );
  }
});

test("rejects records whose timestamp is not a safe identifier", () => {
  const nul = String.fromCharCode(0);
  const mutations: unknown[] = [
    { timestampUnixNano: `1700${nul}000` },
    { timestampUnixNano: "http://localhost:4318" },
    { timestampUnixNano: "1".repeat(RENDERER_OTEL_MAX_STRING_BYTES + 1) },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Metric,
        name: "renderer.metric",
        ...record,
      },
    ],
  }));

  for (const mutation of mutations) {
    assert.deepEqual(parseRendererOtelBridgePayload(mutation), {
      ok: false,
      result: {
        ok: false,
        reason: RendererOtelExportFailureReason.InvalidPayload,
      },
    });
  }
});

test("preserves a safe renderer span status message", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        kind: SpanKind.Internal,
        status: { code: SpanStatusCode.Ok, message: "ready" },
        name: "renderer.span",
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    // The unsafe-message case above drops to a bare `{ code }`; a safe message
    // must survive, or the status filter would be a blanket strip.
    assert.deepEqual(expectGenericRecord(parsed.payload.records, 0).status, {
      code: SpanStatusCode.Ok,
      message: "ready",
    });
  }
});

test("accepts numeric and boolean attribute arrays", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Metric,
        name: "renderer.metric",
        attributes: {
          [RendererOtelAllowedAttributeKey.Values]: [1, 2, 3],
        },
        value: [true, false],
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const record = expectGenericRecord(parsed.payload.records, 0);
    assert.deepEqual(record.attributes, {
      [RendererOtelAllowedAttributeKey.Values]: [1, 2, 3],
    });
    assert.deepEqual(record.value, [true, false]);
  }
});

test("rejects an attribute bag larger than the per-record cap", () => {
  // NOTE: the allowlist has only four members, so any bag past four keys is
  // ALSO allowlist-rejected — the numeric cap is a defence-in-depth bound that
  // can never be the sole cause of a rejection at its current value. This pins
  // the observable outcome (rejected, not truncated) for an over-cap bag.
  const overCapAttributes = Object.fromEntries(
    Array.from(
      { length: RENDERER_OTEL_MAX_ATTRIBUTES_PER_RECORD + 1 },
      (_unused, index) => [`renderer.k${index}`, index]
    )
  );

  assert.deepEqual(
    parseRendererOtelBridgePayload({
      records: [
        {
          signal: DesktopOtelSignal.Trace,
          name: "renderer.span",
          attributes: overCapAttributes,
        },
      ],
    }),
    {
      ok: false,
      result: {
        ok: false,
        reason: RendererOtelExportFailureReason.InvalidPayload,
      },
    }
  );
});

test("parses a minimal log exception carrying no message or stacktrace", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "TypeError",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        },
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const attributes = expectExceptionRecord(
      parsed.payload.records,
      0
    ).attributes;
    assert.deepEqual(attributes, {
      [TelemetryAttribute.ExceptionType]: "TypeError",
      [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
    });
    assert.equal(
      Object.hasOwn(attributes, TelemetryAttribute.ExceptionMessage),
      false,
      "an absent message is omitted, never emitted as an empty string"
    );
  }
});

test("carries scope, timestamp, and dropped counters through a trace exception", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        instrumentationScope: { name: "renderer.boundary", version: "1.2.3" },
        timestampUnixNano: "1700000000000000000",
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        kind: SpanKind.Internal,
        status: { code: SpanStatusCode.Error },
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        },
        droppedAttributesCount: 1,
        droppedEventsCount: 2,
        droppedLinksCount: 3,
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0], payload.records[0]);
  }
});

test("rejects exception records whose timestamp or scope is unsafe", () => {
  const nul = String.fromCharCode(0);
  const mutations: unknown[] = [
    { timestampUnixNano: `1700${nul}000` },
    { instrumentationScope: { name: "" } },
    {
      instrumentationScope: {
        name: "renderer.boundary",
        version: "http://localhost:4318",
      },
    },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        },
        ...record,
      },
    ],
  }));

  for (const mutation of mutations) {
    assert.deepEqual(parseRendererOtelBridgePayload(mutation), {
      ok: false,
      result: {
        ok: false,
        reason: RendererOtelExportFailureReason.InvalidPayload,
      },
    });
  }
});

test("rejects exception records with an absent, empty, over-filled, or untyped attribute bag", () => {
  const mutations: unknown[] = [
    { signal: DesktopOtelSignal.Log, name: "exception" },
    { signal: DesktopOtelSignal.Log, name: "exception", attributes: {} },
    {
      signal: DesktopOtelSignal.Log,
      name: "exception",
      attributes: {
        [TelemetryAttribute.ExceptionType]: "Error",
        [TelemetryAttribute.ExceptionMessage]: "boom",
        [TelemetryAttribute.ExceptionStacktrace]: "in RendererBoundary",
        [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        [RendererOtelAllowedAttributeKey.Status]: "ready",
      },
    },
    {
      signal: DesktopOtelSignal.Log,
      name: "exception",
      attributes: {
        [TelemetryAttribute.ExceptionMessage]: "boom",
        [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
      },
    },
  ].map((record) => ({ records: [record] }));

  for (const mutation of mutations) {
    assert.deepEqual(parseRendererOtelBridgePayload(mutation), {
      ok: false,
      result: {
        ok: false,
        reason: RendererOtelExportFailureReason.InvalidPayload,
      },
    });
  }
});

test("degrades unserializable and undefined payloads instead of throwing", () => {
  // Desktop telemetry export is best-effort (apps/desktop/AGENTS.md): a payload
  // JSON.stringify cannot handle must come back as invalid_payload, never as a
  // throw through the export API.
  const circular: Record<string, unknown> = { records: [] };
  circular.self = circular;

  const payloads: unknown[] = [
    undefined,
    circular,
    { records: [{ signal: DesktopOtelSignal.Trace, name: 1n }] },
  ];

  for (const payload of payloads) {
    assert.deepEqual(parseRendererOtelBridgePayload(payload), {
      ok: false,
      result: {
        ok: false,
        reason: RendererOtelExportFailureReason.InvalidPayload,
      },
    });
  }
});

test("normalizeAttributes keeps only OTel-representable values", () => {
  const normalized = normalizeAttributes({
    text: "ready",
    count: 3,
    enabled: true,
    strings: ["a", "b"],
    numbers: [1, 2],
    flags: [true, false],
    nested: { nope: 1 },
    mixed: ["a", { nope: 1 }],
    missing: undefined,
    empty: null,
    callback: () => undefined,
  });

  assert.deepEqual(normalized, {
    text: "ready",
    count: 3,
    enabled: true,
    strings: ["a", "b"],
    numbers: [1, 2],
    flags: [true, false],
  });
});

test("normalizeInstrumentationScope drops a scope with no name", () => {
  assert.equal(normalizeInstrumentationScope({}), undefined);
  assert.equal(
    normalizeInstrumentationScope({ name: "", version: "1.0.0" }),
    undefined,
    "a version without a name is not a usable scope"
  );
  assert.deepEqual(normalizeInstrumentationScope({ name: "renderer" }), {
    name: "renderer",
  });
  assert.deepEqual(
    normalizeInstrumentationScope({ name: "renderer", version: "1.0.0" }),
    { name: "renderer", version: "1.0.0" }
  );
  assert.deepEqual(
    normalizeInstrumentationScope({ name: "renderer", version: "" }),
    { name: "renderer" }
  );
});

test("hrTimeToUnixNanoString composes seconds and nanos past 2^53", () => {
  assert.equal(hrTimeToUnixNanoString([0, 0]), "0");
  assert.equal(hrTimeToUnixNanoString([1, 500]), "1000000500");

  // Wall-clock nanoseconds exceed Number.MAX_SAFE_INTEGER, which is exactly why
  // the helper works in BigInt and returns a string: a float round-trip silently
  // loses the low-order digits.
  const nanos = hrTimeToUnixNanoString([1_700_000_000, 123_456_789]);
  assert.equal(nanos, "1700000000123456789");
  assert.ok(Number(nanos) > Number.MAX_SAFE_INTEGER);
  assert.notEqual(String(Number(nanos)), nanos);
});

test("hasSpanIdentity requires both a trace id and a span id", () => {
  assert.equal(
    hasSpanIdentity({
      signal: DesktopOtelSignal.Trace,
      traceId: "11111111111111111111111111111111",
      spanId: "2222222222222222",
    }),
    true
  );
  assert.equal(
    hasSpanIdentity({
      signal: DesktopOtelSignal.Trace,
      traceId: "11111111111111111111111111111111",
    }),
    false
  );
  assert.equal(
    hasSpanIdentity({
      signal: DesktopOtelSignal.Trace,
      spanId: "2222222222222222",
    }),
    false
  );
  assert.equal(hasSpanIdentity({ signal: DesktopOtelSignal.Log }), false);
});

test("normalizeSpanKind maps every OTel kind and defaults the unknown", () => {
  assert.equal(normalizeSpanKind(OTelSpanKind.INTERNAL), SpanKind.Internal);
  assert.equal(normalizeSpanKind(OTelSpanKind.SERVER), SpanKind.Server);
  assert.equal(normalizeSpanKind(OTelSpanKind.CLIENT), SpanKind.Client);
  assert.equal(normalizeSpanKind(OTelSpanKind.PRODUCER), SpanKind.Producer);
  assert.equal(normalizeSpanKind(OTelSpanKind.CONSUMER), SpanKind.Consumer);
  // The OTel SDK ships on its own cadence, so a kind this build's enum does not
  // name is version skew arriving at runtime, not a type violation. It must
  // degrade to `internal` rather than emit undefined into the wire record.
  assert.equal(
    normalizeSpanKind(UNKNOWN_OTEL_ENUM_MEMBER as OTelSpanKind),
    SpanKind.Internal
  );
});

test("normalizeSpanStatus maps every OTel status code and keeps messages", () => {
  assert.deepEqual(normalizeSpanStatus({ code: OTelSpanStatusCode.OK }), {
    code: SpanStatusCode.Ok,
  });
  assert.deepEqual(
    normalizeSpanStatus({ code: OTelSpanStatusCode.OK, message: "done" }),
    { code: SpanStatusCode.Ok, message: "done" }
  );
  assert.deepEqual(
    normalizeSpanStatus({ code: OTelSpanStatusCode.ERROR, message: "boom" }),
    { code: SpanStatusCode.Error, message: "boom" }
  );
  assert.deepEqual(normalizeSpanStatus({ code: OTelSpanStatusCode.ERROR }), {
    code: SpanStatusCode.Error,
  });
  assert.deepEqual(normalizeSpanStatus({ code: OTelSpanStatusCode.UNSET }), {
    code: SpanStatusCode.Unset,
  });
  assert.deepEqual(
    normalizeSpanStatus({ code: OTelSpanStatusCode.UNSET, message: "pending" }),
    { code: SpanStatusCode.Unset, message: "pending" }
  );
  // Same version-skew boundary as normalizeSpanKind above. An unknown code
  // degrades to `unset` and must not invent or drop the message either way.
  assert.deepEqual(
    normalizeSpanStatus({
      code: UNKNOWN_OTEL_ENUM_MEMBER as OTelSpanStatusCode,
      message: "later",
    }),
    { code: SpanStatusCode.Unset, message: "later" }
  );
  assert.deepEqual(
    normalizeSpanStatus({
      code: UNKNOWN_OTEL_ENUM_MEMBER as OTelSpanStatusCode,
    }),
    { code: SpanStatusCode.Unset }
  );
});

test("only non-retryable renderer export reasons are terminal", () => {
  assert.equal(
    isTerminalRendererOtelResult({
      ok: true,
      acceptedRecords: 1,
      droppedRecordsCount: 0,
    }),
    false
  );

  const terminal = [
    RendererOtelExportFailureReason.Disabled,
    RendererOtelExportFailureReason.Unavailable,
    RendererOtelExportFailureReason.UntrustedSender,
  ];
  for (const reason of terminal) {
    assert.equal(
      isTerminalRendererOtelResult({ ok: false, reason }),
      true,
      `${reason} must stop the renderer from retrying`
    );
  }

  const retryable = [
    RendererOtelExportFailureReason.ExportFailed,
    RendererOtelExportFailureReason.InvalidPayload,
    RendererOtelExportFailureReason.RateLimited,
  ];
  for (const reason of retryable) {
    assert.equal(
      isTerminalRendererOtelResult({ ok: false, reason }),
      false,
      `${reason} must leave the renderer free to retry`
    );
  }
});

/**
 * A numeric member neither `@opentelemetry/api` enum defines today. It stands in
 * for a value a newer OTel SDK could send through the same mappers.
 */
const UNKNOWN_OTEL_ENUM_MEMBER = 99;
