import {
  SpanKind,
  SpanStatusCode,
} from "@closedloop-ai/telemetry-contract/span";
import {
  type Attributes,
  type AttributeValue,
  type HrTime,
  SpanKind as OTelSpanKind,
  SpanStatusCode as OTelSpanStatusCode,
} from "@opentelemetry/api";
import {
  type DesktopOtelInstrumentationScope,
  type DesktopOtelSpanStatus,
  type RendererOtelBridgeRecord,
  RendererOtelExportFailureReason,
  type RendererOtelExportResult,
  type RendererOtelGenericBridgeRecord,
} from "./renderer-otel-bridge-constants.js";

// Shared, dependency-light helpers used by both the main-process
// (`src/main/app-otel-runtime.ts`) and renderer-process
// (`src/renderer/app-otel-runtime.ts`) OTel runtimes. This module deliberately
// avoids zod / Node built-ins so the renderer can import it without tripping
// the `renderer-otel-runtime-local-only` dependency-cruiser rule (see
// `scripts/dependency-cruiser.config.cjs`).

const CONTROL_CHARACTER_MAX_CODE = 0x1f;
const DELETE_CHARACTER_CODE = 0x7f;

export function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= CONTROL_CHARACTER_MAX_CODE ||
        codePoint === DELETE_CHARACTER_CODE)
    ) {
      return true;
    }
  }
  return false;
}

export function normalizeAttributes(
  attributes: Record<string, unknown>
): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      (entry): entry is [string, AttributeValue] => isAttributeValue(entry[1])
    )
  );
}

function isAttributeValue(value: unknown): value is AttributeValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(
    (item) =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
  );
}

export function normalizeInstrumentationScope(scope: {
  name?: string;
  version?: string;
}): DesktopOtelInstrumentationScope | undefined {
  if (!scope.name) {
    return undefined;
  }
  return {
    name: scope.name,
    ...(scope.version ? { version: scope.version } : {}),
  };
}

export function hrTimeToUnixNanoString(hrTime: HrTime): string {
  return (BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1])).toString();
}

export function hasSpanIdentity(
  record: RendererOtelBridgeRecord
): record is RendererOtelGenericBridgeRecord & {
  spanId: string;
  traceId: string;
} {
  return "traceId" in record && Boolean(record.traceId && record.spanId);
}

export function normalizeSpanKind(kind: OTelSpanKind): SpanKind {
  switch (kind) {
    case OTelSpanKind.SERVER:
      return SpanKind.Server;
    case OTelSpanKind.CLIENT:
      return SpanKind.Client;
    case OTelSpanKind.PRODUCER:
      return SpanKind.Producer;
    case OTelSpanKind.CONSUMER:
      return SpanKind.Consumer;
    case OTelSpanKind.INTERNAL:
      return SpanKind.Internal;
    default:
      return SpanKind.Internal;
  }
}

export function normalizeSpanStatus(status: {
  code: OTelSpanStatusCode;
  message?: string;
}): DesktopOtelSpanStatus {
  switch (status.code) {
    case OTelSpanStatusCode.OK:
      return {
        code: SpanStatusCode.Ok,
        ...(status.message ? { message: status.message } : {}),
      };
    case OTelSpanStatusCode.ERROR:
      return {
        code: SpanStatusCode.Error,
        ...(status.message ? { message: status.message } : {}),
      };
    case OTelSpanStatusCode.UNSET:
      return {
        code: SpanStatusCode.Unset,
        ...(status.message ? { message: status.message } : {}),
      };
    default:
      return {
        code: SpanStatusCode.Unset,
        ...(status.message ? { message: status.message } : {}),
      };
  }
}

export function isTerminalRendererOtelResult(
  result: RendererOtelExportResult
): boolean {
  return (
    !result.ok &&
    (result.reason === RendererOtelExportFailureReason.Disabled ||
      result.reason === RendererOtelExportFailureReason.Unavailable ||
      result.reason === RendererOtelExportFailureReason.UntrustedSender)
  );
}
