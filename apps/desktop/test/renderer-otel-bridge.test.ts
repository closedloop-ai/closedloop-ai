import assert from "node:assert/strict";
import { test } from "node:test";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import { vi } from "vitest";
import { createRendererOtelExportHandler } from "../src/main/ipc/renderer-otel-ipc.js";
import { parseRendererOtelBridgePayload } from "../src/shared/renderer-otel-bridge.js";
import {
  DesktopOtelSignal,
  RENDERER_OTEL_EXPORT_CHANNEL,
  RENDERER_OTEL_MAX_BATCH_BYTES,
  RENDERER_OTEL_MAX_RECORDS_PER_BATCH,
  RENDERER_OTEL_MAX_STRING_BYTES,
  RendererOtelAllowedAttributeKey,
  type RendererOtelBridgePayload,
  RendererOtelExportFailureReason,
} from "../src/shared/renderer-otel-bridge-constants.js";
import {
  expectExceptionRecord,
  expectGenericRecord,
} from "./renderer-otel-bridge-test-fixtures.js";

const trustedEvent = { sender: { id: "trusted" } };

test("parses valid minimized renderer records and preserves optional omission", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        instrumentationScope: { name: "renderer" },
        name: "renderer.span",
        value: ["ready", "active"],
        attributes: {
          [RendererOtelAllowedAttributeKey.Count]: 1,
          [RendererOtelAllowedAttributeKey.Mode]: "test",
          [RendererOtelAllowedAttributeKey.Status]: "ready",
          [RendererOtelAllowedAttributeKey.Values]: ["ready", "active"],
        },
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0], payload.records[0]);
    assert.equal("resourceAttributes" in parsed.payload.records[0], false);
    assert.equal("body" in parsed.payload.records[0], false);
  }
});

test("parses valid renderer span identity and canonical status", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        parentSpanId: "3333333333333333",
        kind: SpanKind.Internal,
        status: { code: SpanStatusCode.Ok },
        name: "renderer.span",
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0], payload.records[0]);
  }
});

test("omits unsafe renderer span status messages", () => {
  const parsed = parseRendererOtelBridgePayload({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        kind: SpanKind.Internal,
        status: {
          code: SpanStatusCode.Error,
          message: "failed with token sk-proj-secret",
        },
        name: "renderer.span",
      },
    ],
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0]?.status, {
      code: SpanStatusCode.Error,
    });
  }
});

test("rejects malformed renderer span identity and non-canonical status", () => {
  const mutations: unknown[] = [
    { traceId: null },
    { traceId: "1111111111111111111111111111111" },
    { traceId: "1111111111111111111111111111111A" },
    { traceId: "00000000000000000000000000000000" },
    { spanId: null },
    { spanId: "222222222222222" },
    { spanId: "222222222222222G" },
    { spanId: "0000000000000000" },
    { parentSpanId: null },
    { parentSpanId: "333333333333333" },
    { kind: "background" },
    { status: { code: "success" } },
    {
      signal: DesktopOtelSignal.Log,
      traceId: "11111111111111111111111111111111",
    },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
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

test("rejects partial renderer span identity", () => {
  const mutations: unknown[] = [
    { traceId: "11111111111111111111111111111111" },
    { spanId: "2222222222222222" },
    { parentSpanId: "3333333333333333" },
    {
      traceId: "11111111111111111111111111111111",
      parentSpanId: "3333333333333333",
    },
    {
      spanId: "2222222222222222",
      parentSpanId: "3333333333333333",
    },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
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

test("parses renderer exception records with closed attributes and renderer origin", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          [TelemetryAttribute.ExceptionMessage]: "Render failed",
          [TelemetryAttribute.ExceptionStacktrace]: "Error: Render failed",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        },
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0], payload.records[0]);
    assert.equal("resourceAttributes" in parsed.payload.records[0], false);
    assert.equal("body" in parsed.payload.records[0], false);
  }
});

test("parses trace-form renderer exception records with complete identity and error status", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        kind: SpanKind.Internal,
        status: { code: SpanStatusCode.Error },
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          [TelemetryAttribute.ExceptionMessage]: "Render failed",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        },
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0], payload.records[0]);
  }
});

test("rejects trace-form renderer exceptions without complete error identity", () => {
  const mutations: unknown[] = [
    { traceId: undefined },
    { spanId: undefined },
    { status: { code: SpanStatusCode.Unset } },
    { status: { code: SpanStatusCode.Ok } },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        traceId: "11111111111111111111111111111111",
        spanId: "2222222222222222",
        kind: SpanKind.Internal,
        status: { code: SpanStatusCode.Error },
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

test("redacts unsafe renderer exception optional fields without dropping the event", () => {
  const parsed = parseRendererOtelBridgePayload({
    records: [
      {
        signal: DesktopOtelSignal.Log,
        name: "exception",
        attributes: {
          [TelemetryAttribute.ExceptionType]: "Error",
          [TelemetryAttribute.ExceptionMessage]:
            "failed with token sk-proj-secret",
          [TelemetryAttribute.ExceptionStacktrace]:
            "Error: failed at /Users/example/project/app.ts",
          [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Renderer,
        },
      },
    ],
  });

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    const attributes = expectExceptionRecord(
      parsed.payload.records,
      0
    ).attributes;
    assert.equal(attributes[TelemetryAttribute.ExceptionType], "Error");
    assert.equal(
      attributes[TelemetryAttribute.AppExceptionOrigin],
      AppExceptionOrigin.Renderer
    );
    assert.equal(attributes[TelemetryAttribute.ExceptionMessage], "[redacted]");
    assert.equal(
      attributes[TelemetryAttribute.ExceptionStacktrace],
      "Error: failed at [redacted-path]"
    );
    // The sanitizer must OMIT an unsafe attribute, never emit an explicit
    // `null` — read the values untyped so the runtime check is meaningful.
    const attributeValues: unknown[] = Object.values(attributes);
    assert.equal(attributeValues.includes(null), false);
  }
});

test("rejects renderer exception records with spoofed origin, resource fields, or unsupported attributes", () => {
  const mutations: unknown[] = [
    {
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "exception",
          attributes: {
            [TelemetryAttribute.ExceptionType]: "Error",
            [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,
          },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "exception",
          attributes: {
            [TelemetryAttribute.ExceptionType]: "Error",
            [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.PreInit,
          },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "exception",
          resourceAttributes: { "service.name": "renderer" },
          attributes: {
            [TelemetryAttribute.ExceptionType]: "Error",
            [TelemetryAttribute.AppExceptionOrigin]:
              AppExceptionOrigin.Renderer,
          },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "exception",
          droppedEventsCount: 1,
          attributes: {
            [TelemetryAttribute.ExceptionType]: "Error",
            [TelemetryAttribute.AppExceptionOrigin]:
              AppExceptionOrigin.Renderer,
          },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "exception",
          droppedLinksCount: 1,
          attributes: {
            [TelemetryAttribute.ExceptionType]: "Error",
            [TelemetryAttribute.AppExceptionOrigin]:
              AppExceptionOrigin.Renderer,
          },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Log,
          name: "exception",
          attributes: {
            [TelemetryAttribute.ExceptionType]: "Error",
            [TelemetryAttribute.AppExceptionOrigin]:
              AppExceptionOrigin.Renderer,
            body: "raw body",
          },
        },
      ],
    },
  ];

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

test("rejects sensitive, resource-like, path, URL, and unknown top-level payload fields", () => {
  const mutations: unknown[] = [
    {
      records: [
        {
          signal: DesktopOtelSignal.Trace,
          name: "renderer.span",
          body: "raw body",
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Trace,
          name: "renderer.span",
          resourceAttributes: { "service.version": "renderer" },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Trace,
          name: "renderer.span",
          attributes: { prompt: "tell me a secret" },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Trace,
          name: "renderer.span",
          attributes: { "renderer.path": "/Users/peter/project" },
        },
      ],
    },
    {
      records: [
        {
          signal: DesktopOtelSignal.Trace,
          name: "http://localhost:4318",
        },
      ],
    },
  ];

  for (const mutation of mutations) {
    const parsed = parseRendererOtelBridgePayload(mutation);
    assert.deepEqual(parsed, {
      ok: false,
      result: {
        ok: false,
        reason: RendererOtelExportFailureReason.InvalidPayload,
      },
    });
  }
});

test("rejects unapproved renderer attribute keys before append", () => {
  const mutation = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
        attributes: {
          [RendererOtelAllowedAttributeKey.Status]: "ready",
          "renderer.customer_segment": "enterprise",
        },
      },
    ],
  };

  assert.deepEqual(parseRendererOtelBridgePayload(mutation), {
    ok: false,
    result: {
      ok: false,
      reason: RendererOtelExportFailureReason.InvalidPayload,
    },
  });
});

test("rejects sensitive renderer record value strings and arrays", () => {
  const mutations: unknown[] = [
    { value: "prompt token /Users/peter/.ssh/id_rsa" },
    { value: "/tmp/cache/data.json" },
    { value: "/var/folders/aa/bb/data.json" },
    { value: "/etc/passwd" },
    { value: "C:/Temp/cache/data.json" },
    { value: "D:/work/cache/data.bin" },
    { value: "C:/ProgramData/App/data.json" },
    { value: String.raw`\\server\share\data.json` },
    { value: String.raw`C:\Temp\cache\data.json` },
    { value: String.raw`\tmp\data.json` },
    { value: String.raw`\var\folders\aa\bb\data.json` },
    { value: "relative/project/data.json" },
    { value: String.raw`relative\project\data.json` },
    { value: String.raw`.\relative\project.json` },
    { value: String.raw`..\relative\project.json` },
    { value: "http://localhost:4318/v1/traces" },
    { value: "session raw error stack trace" },
    { value: "sk-proj-secret" },
    { value: "github_pat_1234567890abcdefghijklmnop" },
    { value: ["ready", "/home/peter/secret-session.txt"] },
    { value: ["ready", "C:/Temp/cache/data.json"] },
    { value: ["ready", String.raw`\\server\share\data.json`] },
    { value: ["ready", String.raw`D:\work\cache\data.bin`] },
    { value: ["ready", String.raw`\tmp\data.json`] },
    { value: ["ready", String.raw`relative\project\data.json`] },
    { value: ["ready", "https://example.test/path"] },
    { value: ["ready", "sk-proj-secret"] },
    { value: "a".repeat(RENDERER_OTEL_MAX_BATCH_BYTES) },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
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

test("rejects secret-shaped values in allowlisted renderer attributes", () => {
  const mutations: unknown[] = [
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "sk-proj-secret",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "/tmp/cache/data.json",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "C:/Temp/cache/data.json",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "D:/work/cache/data.bin",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: String.raw`\\server\share\data.json`,
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: String.raw`\tmp\data.json`,
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "relative/project/data.json",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: String.raw`relative\project\data.json`,
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: String.raw`.\relative\project.json`,
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: String.raw`..\relative\project.json`,
      },
    },
    // Google OAuth shapes. Both are written so ONLY the ya29./1// secret
    // alternatives can match: no path delimiter precedes `1//`, which would
    // otherwise let the canonical relative-path pattern reject it and leave the
    // refresh-token alternative untested. ISS-6229 added `=` to that delimiter
    // set, so the separator here is `:`, which is deliberately not one.
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]:
          "ya29.a0AfB1234567890abcdefghijklmn",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]:
          "refreshed:1//0gABCDEFGHIJKLMNOPQRSTUVWX1234",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "ready",
        [RendererOtelAllowedAttributeKey.Values]: ["active", "sk-proj-secret"],
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "ready",
        [RendererOtelAllowedAttributeKey.Values]: [
          "active",
          "C:/ProgramData/App/data.json",
        ],
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "ready",
        [RendererOtelAllowedAttributeKey.Values]: [
          "active",
          String.raw`\\server\share\data.json`,
        ],
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "ready",
        [RendererOtelAllowedAttributeKey.Values]: [
          "active",
          String.raw`\var\folders\aa\bb\data.json`,
        ],
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "ready",
        [RendererOtelAllowedAttributeKey.Values]: [
          "active",
          String.raw`relative\project\data.json`,
        ],
      },
    },
    // ISS-6229: the shapes the bridge's own copies of the path/URL patterns
    // could not see — a `file://` frame (they had no `file://` arm), a
    // `(`-wrapped V8 location (no `(` in the delimiter class), a non-http
    // scheme (http-only URL matching), and an email (no email check at all).
    //
    // The `/opt/...` and `bob@...` values are the load-bearing ones: they carry
    // no substring of SENSITIVE_KEY_PATTERN, so nothing but the canonical
    // path/URL/email check can reject them. `/Users/...` would be caught
    // incidentally by that key pattern's bare `user`/`file` alternatives and so
    // proves nothing on its own.
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "file:///opt/acme/build.js",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "at fn (/opt/acme/build.js)",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "bob@example.com",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "opened closedloop://a/b",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "file:///Users/alice/app.js",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "at fn (/Users/alice/app.js)",
      },
    },
    {
      attributes: {
        [RendererOtelAllowedAttributeKey.Status]: "ready",
        [RendererOtelAllowedAttributeKey.Values]: [
          "active",
          "at fn (/opt/acme/build.js)",
        ],
      },
    },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
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

test("preserves developer-controlled names containing sensitive substrings", () => {
  // Span names and instrumentation-scope names/versions are
  // developer-controlled identifiers, not user data. Substrings like
  // "session", "user", "error", "resource", and "path" must NOT cause the
  // record (and its whole batch) to be silently dropped.
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        instrumentationScope: { name: "renderer.session", version: "1.user.0" },
        name: "renderer.session.user.error.resource.path",
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0], payload.records[0]);
  }
});

test("preserves HTTP-route-style and slash-bearing developer span names", () => {
  // The identifier sanitizer deliberately omits the FILE/RELATIVE path patterns,
  // so legitimate slash-bearing names (OTel HTTP span names, slashed scope
  // names) survive. User-supplied data belongs in attribute values, which remain
  // fully path-filtered. This is the relaxation the HIGH finding prescribed.
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        instrumentationScope: { name: "renderer/router" },
        name: "GET /settings/profile",
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.payload.records[0], payload.records[0]);
  }
});

test("still rejects names carrying URLs, secrets, control chars, or overflow", () => {
  const mutations: unknown[] = [
    { name: "http://localhost:4318" },
    { name: "renderer.sk-proj-abcdefghij" },
    { name: "renderer.\u007fspan" },
    { name: "renderer.\u0000span" },
    {
      name: "renderer.span",
      instrumentationScope: { name: "scope.\u0007name" },
    },
    { name: "a".repeat(RENDERER_OTEL_MAX_STRING_BYTES + 1) },
  ].map((record) => ({
    records: [
      {
        signal: DesktopOtelSignal.Trace,
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

test("preserves safe renderer record scalar values", () => {
  const payload: RendererOtelBridgePayload = {
    records: [
      {
        signal: DesktopOtelSignal.Metric,
        name: "renderer.metric",
        value: 3,
      },
      {
        signal: DesktopOtelSignal.Metric,
        name: "renderer.metric.series",
        value: ["ready", "active"],
      },
    ],
  };

  const parsed = parseRendererOtelBridgePayload(payload);

  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(expectGenericRecord(parsed.payload.records, 0).value, 3);
    assert.deepEqual(expectGenericRecord(parsed.payload.records, 1).value, [
      "ready",
      "active",
    ]);
  }
});

test("rejects oversized batches before append", () => {
  const tooManyRecords = {
    records: Array.from(
      { length: RENDERER_OTEL_MAX_RECORDS_PER_BATCH + 1 },
      () => ({
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
      })
    ),
  };
  const oversizedString = "a".repeat(RENDERER_OTEL_MAX_BATCH_BYTES);
  const oversizedPayload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: oversizedString,
      },
    ],
  };

  assert.equal(parseRendererOtelBridgePayload(tooManyRecords).ok, false);
  assert.equal(parseRendererOtelBridgePayload(oversizedPayload).ok, false);
});

test("handler rejects untrusted sender before parse or append", async () => {
  const parsePayload = vi.fn(() => {
    throw new Error("parse should not run");
  });
  const runtime = makeRuntime();
  const handler = createRendererOtelExportHandler({
    isTrustedSender: () => false,
    parsePayload,
    runtime,
  });

  const result = await handler({ sender: { id: "evil" } }, { bad: true });

  assert.deepEqual(result, {
    ok: false,
    reason: RendererOtelExportFailureReason.UntrustedSender,
  });
  assert.equal(parsePayload.mock.calls.length, 0);
  assert.equal(runtime.exportCalls, 0);
});

test("handler forwards sanitized records and rate-limits sustained batches", async () => {
  const runtime = makeRuntime();
  const handler = createRendererOtelExportHandler({
    isTrustedSender: () => true,
    now: () => 10,
    runtime,
  });

  const payload = {
    records: [
      {
        signal: DesktopOtelSignal.Trace,
        name: "renderer.span",
      },
    ],
  };
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await handler(trustedEvent, payload)).ok, true);
  }

  assert.deepEqual(await handler(trustedEvent, payload), {
    ok: false,
    reason: RendererOtelExportFailureReason.RateLimited,
  });
  assert.equal(runtime.exportCalls, 8);
});

test("production preload API invokes only the renderer OTel channel", async () => {
  const invoke = vi.fn((_channel: string, ..._args: unknown[]) =>
    Promise.resolve({ ok: true })
  );
  const send = vi.fn();
  const { createDesktopApi } = await import("../src/main/preload-common.js");
  const desktopApi = createDesktopApi({ invoke, send });

  assert.equal(typeof desktopApi.exportOtelTelemetry, "function");
  assert.equal("invoke" in desktopApi, false);
  assert.equal("ipcRenderer" in desktopApi, false);
  await desktopApi.exportOtelTelemetry({ records: [] });

  assert.equal(invoke.mock.calls.length, 1);
  assert.equal(invoke.mock.calls[0][0], RENDERER_OTEL_EXPORT_CHANNEL);
});

function makeRuntime() {
  return {
    exportCalls: 0,
    start() {
      return Promise.resolve();
    },
    flush() {
      return Promise.resolve();
    },
    shutdown() {
      return Promise.resolve();
    },
    getBufferedRecords() {
      return [];
    },
    resetBuffer() {},
    // The renderer-export handler only ever reaches `exportExternalRecords`;
    // the emit surface is stubbed so this double satisfies the whole
    // DesktopOtelRuntime contract rather than a convenient slice of it.
    emitAppLifecycleEvent() {},
    emitAppExceptionEvent() {},
    emitIpcPerfEvent() {},
    emitSyncBatchEvent() {},
    emitImportHealthEvent() {},
    exportExternalRecords() {
      this.exportCalls += 1;
      return {
        ok: true,
        acceptedRecords: 1,
        droppedRecordsCount: 0,
      } as const;
    },
  };
}
