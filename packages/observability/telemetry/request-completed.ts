import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import { SpanTelemetrySchema } from "@closedloop-ai/telemetry-contract/span";
import { log } from "../log";
import { emit } from "./contract";

const CONTROL_CHARACTER_MAX_CODE = 0x1f;
const DELETE_CHARACTER_CODE = 0x7f;
const C1_CONTROL_CHARACTER_MIN_CODE = 0x80;
const C1_CONTROL_CHARACTER_MAX_CODE = 0x9f;
const URL_SCHEME_SEPARATOR = "://";
export const REQUEST_COMPLETED_CONTRACT_EVENT_NAME =
  "request_completed.contract";
const URL_PATH_FALLBACK = "/";

export type RequestCompletedSpanInput = {
  requestUrl: string;
  method: string;
  statusCode: number;
  durationMs: number;
};

export function emitRequestCompletedSpan(
  input: RequestCompletedSpanInput
): void {
  try {
    const attributesResult = SpanTelemetrySchema.safeParse({
      [TelemetryAttribute.HttpRequestMethod]: input.method,
      [TelemetryAttribute.HttpResponseStatusCode]: input.statusCode,
      [TelemetryAttribute.UrlPath]: normalizeRequestCompletedUrlPath(
        input.requestUrl
      ),
      [TelemetryAttribute.DurationMs]: input.durationMs,
    });

    if (!attributesResult.success) {
      logRequestCompletedContractFailure("schema_validation_failed");
      return;
    }

    emit(TelemetrySchemaName.Span, {
      name: REQUEST_COMPLETED_CONTRACT_EVENT_NAME,
      attributes: attributesResult.data,
    });
  } catch (error) {
    logRequestCompletedContractFailure("emit_failed", error);
  }
}

export function normalizeRequestCompletedUrlPath(requestUrl: string): string {
  const rawPathname = extractRawPathname(requestUrl);
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return URL_PATH_FALLBACK;
  }

  if (
    containsControlCharacter(rawPathname) ||
    containsControlCharacter(pathname)
  ) {
    return URL_PATH_FALLBACK;
  }

  const result =
    SpanTelemetrySchema.shape[TelemetryAttribute.UrlPath].safeParse(pathname);
  return result.success ? pathname : URL_PATH_FALLBACK;
}

function extractRawPathname(requestUrl: string): string {
  const schemeIndex = requestUrl.indexOf(URL_SCHEME_SEPARATOR);
  const authorityStart =
    schemeIndex === -1 ? 0 : schemeIndex + URL_SCHEME_SEPARATOR.length;
  const pathStart = requestUrl.indexOf("/", authorityStart);
  if (pathStart === -1) {
    return URL_PATH_FALLBACK;
  }

  const queryStart = requestUrl.indexOf("?", pathStart);
  const fragmentStart = requestUrl.indexOf("#", pathStart);
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, requestUrl.length].filter(
      (index) => index >= 0
    )
  );
  return requestUrl.slice(pathStart, pathEnd);
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= CONTROL_CHARACTER_MAX_CODE ||
      code === DELETE_CHARACTER_CODE ||
      (code >= C1_CONTROL_CHARACTER_MIN_CODE &&
        code <= C1_CONTROL_CHARACTER_MAX_CODE)
    ) {
      return true;
    }
  }
  return false;
}

function logRequestCompletedContractFailure(
  reason: "emit_failed" | "schema_validation_failed",
  error?: unknown
): void {
  try {
    log.warn("request_completed.contract emit skipped", {
      reason,
      ...(error !== undefined && { error }),
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  } catch {
    // Telemetry emission must not affect request handling.
  }
}
