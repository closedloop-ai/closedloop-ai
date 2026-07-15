import type { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import type { Attributes, AttributeValue } from "@opentelemetry/api";

export const RENDERER_OTEL_EXPORT_CHANNEL = "desktop:otel:export";

export const DesktopOtelSignal = {
  Trace: "trace",
  Metric: "metric",
  Log: "log",
} as const;

export type DesktopOtelSignal =
  (typeof DesktopOtelSignal)[keyof typeof DesktopOtelSignal];

export const RendererOtelExportFailureReason = {
  Disabled: "disabled",
  ExportFailed: "export_failed",
  InvalidPayload: "invalid_payload",
  RateLimited: "rate_limited",
  Unavailable: "unavailable",
  UntrustedSender: "untrusted_sender",
} as const;

export type RendererOtelExportFailureReason =
  (typeof RendererOtelExportFailureReason)[keyof typeof RendererOtelExportFailureReason];

export const RendererOtelAllowedAttributeKey = {
  Count: "renderer.count",
  Mode: "renderer.mode",
  Status: "renderer.status",
  Values: "renderer.values",
} as const;

export type RendererOtelAllowedAttributeKey =
  (typeof RendererOtelAllowedAttributeKey)[keyof typeof RendererOtelAllowedAttributeKey];

export const RendererOtelExceptionAttributeKey = {
  ExceptionType: TelemetryAttribute.ExceptionType,
  ExceptionMessage: TelemetryAttribute.ExceptionMessage,
  ExceptionStacktrace: TelemetryAttribute.ExceptionStacktrace,
  AppExceptionOrigin: TelemetryAttribute.AppExceptionOrigin,
} as const;

export type RendererOtelExceptionAttributeKey =
  (typeof RendererOtelExceptionAttributeKey)[keyof typeof RendererOtelExceptionAttributeKey];

export type RendererOtelExportResult =
  | { ok: true; acceptedRecords: number; droppedRecordsCount: number }
  | { ok: false; reason: RendererOtelExportFailureReason };

export type DesktopOtelInstrumentationScope = {
  name: string;
  version?: string;
};

export type DesktopOtelBufferedRecord = {
  signal: DesktopOtelSignal;
  resourceAttributes: Attributes;
  droppedRecordsCount: number;
  instrumentationScope?: DesktopOtelInstrumentationScope;
  timestampUnixNano?: string;
  name?: string;
  body?: unknown;
  value?: unknown;
  attributes?: Attributes;
  droppedAttributesCount?: number;
  droppedEventsCount?: number;
  droppedLinksCount?: number;
};

export type RendererOtelGenericAttributes = Partial<
  Record<RendererOtelAllowedAttributeKey, AttributeValue>
>;

export type RendererOtelExceptionAttributes = {
  [TelemetryAttribute.ExceptionType]: string;
  [TelemetryAttribute.AppExceptionOrigin]: typeof AppExceptionOrigin.Renderer;
  [TelemetryAttribute.ExceptionMessage]?: string;
  [TelemetryAttribute.ExceptionStacktrace]?: string;
};

export type RendererOtelGenericBridgeRecord = {
  signal: DesktopOtelSignal;
  instrumentationScope?: DesktopOtelInstrumentationScope;
  timestampUnixNano?: string;
  name?: string;
  value?: AttributeValue;
  attributes?: RendererOtelGenericAttributes;
  droppedAttributesCount?: number;
  droppedEventsCount?: number;
  droppedLinksCount?: number;
};

export type RendererOtelExceptionBridgeRecord = {
  signal: typeof DesktopOtelSignal.Log;
  instrumentationScope?: DesktopOtelInstrumentationScope;
  timestampUnixNano?: string;
  name: "exception";
  attributes: RendererOtelExceptionAttributes;
  droppedAttributesCount?: number;
};

export type RendererOtelBridgeRecord =
  | RendererOtelGenericBridgeRecord
  | RendererOtelExceptionBridgeRecord;

export type RendererOtelBridgePayload = {
  records: RendererOtelBridgeRecord[];
};

export const RENDERER_OTEL_MAX_RECORDS_PER_BATCH = 100;
export const RENDERER_OTEL_MAX_ATTRIBUTES_PER_RECORD = 64;
export const RENDERER_OTEL_MAX_STRING_BYTES = 4096;
export const RENDERER_OTEL_MAX_BATCH_BYTES = 64 * 1024;
export const RENDERER_OTEL_RATE_LIMIT_WINDOW_MS = 1000;
export const RENDERER_OTEL_RATE_LIMIT_MAX_BATCHES = 8;

// FEA-1998: fraction of render commits sampled into wide events. `mount` commits
// always bypass this (rare + most diagnostic); `update`/`nested-update` commits
// are head-sampled here, in the renderer, before a record is ever built — so
// the sanitizer rate limit (8 batches/s) is never the throttle in practice.
export const RENDERER_RENDER_COMMIT_SAMPLE_RATE = 0.1;
