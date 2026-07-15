import type { AppTelemetry } from "../app";
import { AppExceptionOrigin } from "../app-exception-origin";
import type { PermissionTelemetry } from "../permission";
import { TelemetryAttribute } from "../src/attributes";
import { createEmit, createSpanEmit, emit, emitSpan } from "../src/emit";
import type { GenAiTelemetry } from "../src/gen-ai";
import { TelemetrySchemaName } from "../src/schema-name";
import type { TelemetrySpanEnvelopePayload } from "../src/schema-shape";
import { SpanKind, SpanStatusCode, type SpanTelemetry } from "../src/span";
import type { SyncTelemetry } from "../sync";

const channel = {
  info(_message: string, _meta: Record<string, unknown>) {},
};
const spanChannel = {
  span(_envelope: Record<string, unknown>) {},
};
const emitWithChannel = createEmit(channel);
const emitSpanWithChannel = createSpanEmit(spanChannel);

const appAttributes = {
  [TelemetryAttribute.AppInstallationId]: "install_0123456789abcdef",
  [TelemetryAttribute.AppExceptionOrigin]: AppExceptionOrigin.Main,
  [TelemetryAttribute.AppOperatingMode]: "single_player",
  [TelemetryAttribute.AppLifecycleEvent]: "start",
} satisfies AppTelemetry;

const spanAttributes = {
  [TelemetryAttribute.HttpRequestMethod]: "GET",
  [TelemetryAttribute.HttpResponseStatusCode]: 200,
  [TelemetryAttribute.UrlPath]: "/ok",
  [TelemetryAttribute.DurationMs]: 1,
} satisfies SpanTelemetry;

const genAiAttributes = {
  [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
  [TelemetryAttribute.GenAiUsageInputTokens]: 10,
} satisfies GenAiTelemetry;

const syncAttributes = {
  [TelemetryAttribute.SyncEvent]: "batch",
  [TelemetryAttribute.SyncOutcome]: "success",
  [TelemetryAttribute.SyncPayloadBytes]: 128,
  [TelemetryAttribute.SyncLatencyMs]: 12.5,
} satisfies SyncTelemetry;

const permissionAttributes = {
  [TelemetryAttribute.GenAiPermissionDecision]: "allow",
  [TelemetryAttribute.GenAiPermissionSource]: "config",
} satisfies PermissionTelemetry;

const spanEnvelopeAttributes = {
  ...spanAttributes,
  [TelemetryAttribute.DurationMs]: 1,
} satisfies SpanTelemetry & { [TelemetryAttribute.DurationMs]: 1 };

const spanEnvelope = {
  trace_id: "0123456789abcdef0123456789abcdef",
  span_id: "0123456789abcdef",
  name: "http.request",
  kind: SpanKind.Internal,
  status: {
    code: SpanStatusCode.Ok,
  },
  duration_ms: 1,
  schema_name: TelemetrySchemaName.Span,
  attributes: spanEnvelopeAttributes,
} satisfies TelemetrySpanEnvelopePayload<
  typeof TelemetrySchemaName.Span,
  SpanTelemetry,
  1
>;

emit(TelemetrySchemaName.Span, {
  name: "http.request",
  attributes: spanAttributes,
});
emitWithChannel(TelemetrySchemaName.App, {
  name: "app.lifecycle",
  attributes: appAttributes,
});
emitWithChannel(TelemetrySchemaName.GenAi, {
  name: "gen_ai.request",
  attributes: genAiAttributes,
});
emitWithChannel(TelemetrySchemaName.Sync, {
  name: "sync.batch",
  attributes: syncAttributes,
});
emitWithChannel(TelemetrySchemaName.Permission, {
  name: "gen_ai.permission",
  attributes: permissionAttributes,
});
emitSpan(spanEnvelope);
emitSpanWithChannel(spanEnvelope);

emit(TelemetrySchemaName.Span, {
  name: "missing",
  // @ts-expect-error Span attributes require status, URL path, and duration.
  attributes: { [TelemetryAttribute.HttpRequestMethod]: "GET" },
});

emit(TelemetrySchemaName.GenAi, {
  name: "wrong-token",
  attributes: {
    [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
    // @ts-expect-error GenAI token counts must be numeric.
    [TelemetryAttribute.GenAiUsageInputTokens]: "10",
  },
});

emit(TelemetrySchemaName.App, {
  name: "wrong-mode",
  attributes: {
    // @ts-expect-error App operating mode must be one of the published values.
    [TelemetryAttribute.AppOperatingMode]: "co_op",
  },
});

emit(TelemetrySchemaName.App, {
  name: "wrong-exception-origin",
  attributes: {
    // @ts-expect-error App exception origin must be one of the published values.
    [TelemetryAttribute.AppExceptionOrigin]: "worker",
  },
});

emit(TelemetrySchemaName.Sync, {
  name: "wrong-sync-outcome",
  attributes: {
    // @ts-expect-error Sync outcome must be one of the published values.
    [TelemetryAttribute.SyncOutcome]: "partial",
  },
});

emit(TelemetrySchemaName.Permission, {
  name: "wrong-permission-decision",
  attributes: {
    // @ts-expect-error Permission decision must be one of the published values.
    [TelemetryAttribute.GenAiPermissionDecision]: "ask",
  },
});

emit(TelemetrySchemaName.Span, {
  name: "fresh-extra",
  attributes: {
    ...spanAttributes,
    // @ts-expect-error Span emit rejects unknown fresh-literal attributes.
    "not.in.schema": 1,
  },
});

const spanAttributesWithOrigin = {
  ...spanAttributes,
  origin: "api",
};

emit(TelemetrySchemaName.Span, {
  name: "origin-extra",
  // @ts-expect-error Span emit rejects prebuilt variables with reserved logger extras.
  attributes: spanAttributesWithOrigin,
});

const spanAttributesWithUnknown = {
  ...spanAttributes,
  "not.in.schema": 1,
};

emit(TelemetrySchemaName.Span, {
  name: "unknown-extra",
  // @ts-expect-error Span emit rejects prebuilt variables with unknown extras.
  attributes: spanAttributesWithUnknown,
});

const spanPayloadWithUnknown = {
  name: "prebuilt-payload-unknown-extra",
  attributes: spanAttributesWithUnknown,
};

// @ts-expect-error Span emit rejects prebuilt payload variables with unknown extras.
emit(TelemetrySchemaName.Span, spanPayloadWithUnknown);

// @ts-expect-error Span envelopes require top-level duration_ms.
emitSpan({
  trace_id: "0123456789abcdef0123456789abcdef",
  span_id: "0123456789abcdef",
  name: "missing-duration",
  kind: SpanKind.Internal,
  status: {
    code: SpanStatusCode.Ok,
  },
  schema_name: TelemetrySchemaName.Span,
  attributes: spanAttributes,
});

emitSpan({
  ...spanEnvelope,
  attributes: {
    ...spanAttributes,
    // @ts-expect-error Span envelope nested attributes reject unknown fresh keys.
    "not.in.schema": 1,
  },
});

const spanEnvelopeAttributesWithUnknown = {
  ...spanAttributes,
  "not.in.schema": 1,
};

emitSpan({
  ...spanEnvelope,
  // @ts-expect-error Span envelope rejects prebuilt nested attributes with unknown extras.
  attributes: spanEnvelopeAttributesWithUnknown,
});

const _mismatchedDurationEnvelope = {
  trace_id: "0123456789abcdef0123456789abcdef",
  span_id: "0123456789abcdef",
  name: "mismatched-duration",
  kind: SpanKind.Internal,
  status: {
    code: SpanStatusCode.Ok,
  },
  duration_ms: 1,
  schema_name: TelemetrySchemaName.Span,
  attributes: {
    ...spanAttributes,
    // @ts-expect-error Span envelope duration mirrors the top-level literal when expressible.
    [TelemetryAttribute.DurationMs]: 2,
  },
} satisfies TelemetrySpanEnvelopePayload<
  typeof TelemetrySchemaName.Span,
  SpanTelemetry & { [TelemetryAttribute.DurationMs]: 2 },
  1
>;

emitSpan({
  ...spanEnvelope,
  // @ts-expect-error Span envelopes require a published schema name.
  schema_name: "trace",
});
