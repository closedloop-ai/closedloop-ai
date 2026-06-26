import type { AppTelemetry } from "../app";
import { AppExceptionOrigin } from "../app-exception-origin";
import type { PermissionTelemetry } from "../permission";
import { TelemetryAttribute } from "../src/attributes";
import { createEmit, emit } from "../src/emit";
import type { GenAiTelemetry } from "../src/gen-ai";
import { TelemetrySchemaName } from "../src/schema-name";
import type { SpanTelemetry } from "../src/span";
import type { SyncTelemetry } from "../sync";

const channel = {
  info(_message: string, _meta: Record<string, unknown>) {},
};
const emitWithChannel = createEmit(channel);

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
