import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { TelemetryEmitMetadataKey } from "@closedloop-ai/telemetry-contract/emit";
import { TelemetrySchemaName } from "@closedloop-ai/telemetry-contract/schema-name";
import {
  type SpanErrorSource,
  SpanTelemetrySchema,
} from "@closedloop-ai/telemetry-contract/span";
import { log } from "../log";

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
  /**
   * Per-request attribution the caller resolved, all optional. Each field is
   * OMITTED from the span when absent rather than defaulted (ISS-7221,
   * ISS-8748): an unauthenticated or rejected request has neither a tenant nor
   * an actor, and inventing either would make "which org is failing" and "who
   * was affected" answerable and wrong.
   */
  attribution?: RequestCompletedSpanAttribution;
};

/** Optional per-request span attribution resolved by the API layer. */
export type RequestCompletedSpanAttribution = {
  /** Internal organization id — the join key desktop telemetry already carries. */
  organizationId?: string;
  /**
   * Internal database user id (ISS-8748). Pseudonymous operational attribution
   * only — never an email, a display name, or a Clerk id.
   */
  userId?: string;
  /**
   * Desktop install that made the call (ISS-8749). CALLER-ATTESTED: read off a
   * request header the client writes for itself, so it is telemetry and never
   * evidence — nothing may authenticate, authorize, scope, or route on it.
   */
  installationId?: string;
  /**
   * Desktop build that made the call (ISS-8749). Same caller-attested standing
   * as `installationId`, and deliberately NOT `service.version`, which on this
   * span names the API's own build.
   */
  clientVersion?: string;
  /** Which layer produced a 5xx (ISS-7217). */
  errorSource?: SpanErrorSource;
  /** Identifier-shaped exception class or error code (ISS-7217). */
  errorType?: string;
  /** Canonical artifact subtype the request touched (ISS-7224). */
  artifactType?: string;
  /** Canonical artifact status the request touched (ISS-7224). */
  artifactStatus?: string;
  /**
   * Client-generated sync batch id the request body carried (ISS-7227). The
   * join key between a desktop sync failure record and the server request that
   * produced it. Read off the body under the same UUID constraint the ingest
   * schema applies, so a body that carries no readable id — every rejection the
   * desktop cannot name either — stays honestly unjoinable rather than
   * carrying a guessed one.
   */
  syncBatchId?: string;
};

/**
 * Build the schema-validated contract attributes for a completed request, for
 * the caller to merge into its own `request_completed` log line.
 *
 * ISS-5039: this used to `emit()` a second `request_completed.contract` log
 * line carrying the same four values under their OTel names. Every deployed
 * log call is ingested twice — once via the Vercel Log Drain (`source:vercel`)
 * and once via the agentless HTTP intake in `log.ts` (`source:nodejs`) — so a
 * second line cost two more billed events per request, measured at 500,580
 * events over three days on `cl-api` alone. Nothing consumed it: Datadog's
 * phrase query `"request_completed"` does not match the token sequence in
 * `request_completed.contract`, so the `api.requests.*` log-based metrics and
 * the `cl-api` log monitors all matched only the plain line.
 *
 * Returning the attributes instead keeps them on the single line, under the
 * same keys and alongside the same `telemetry.schema_name` marker, so a
 * contract consumer still finds them by attribute rather than by event name.
 *
 * Returns `undefined` when the values do not satisfy the span schema, so the
 * caller emits its own line unchanged rather than an attribute set that never
 * validated.
 */
export function buildRequestCompletedContractAttributes(
  input: RequestCompletedSpanInput
): Record<string, unknown> | undefined {
  try {
    const attributesResult = SpanTelemetrySchema.safeParse({
      [TelemetryAttribute.HttpRequestMethod]: input.method,
      [TelemetryAttribute.HttpResponseStatusCode]: input.statusCode,
      [TelemetryAttribute.UrlPath]: normalizeRequestCompletedUrlPath(
        input.requestUrl
      ),
      [TelemetryAttribute.DurationMs]: input.durationMs,
      ...attributionAttributes(input.attribution),
    });

    if (!attributesResult.success) {
      logRequestCompletedContractFailure("schema_validation_failed");
      return undefined;
    }

    return {
      ...attributesResult.data,
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    };
  } catch (error) {
    logRequestCompletedContractFailure("build_failed", error);
    return undefined;
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

/**
 * Span attributes carrying per-request attribution.
 *
 * Declared as an exhaustive `Record` over the attribution fields so a new field
 * fails `tsc` here until someone writes down which span attribute it becomes —
 * which is the moment to ask whether it can carry user content.
 */
const SpanAttributionAttribute = {
  organizationId: TelemetryAttribute.AppOrganizationId,
  userId: TelemetryAttribute.UserId,
  installationId: TelemetryAttribute.AppInstallationId,
  clientVersion: TelemetryAttribute.AppClientVersion,
  errorSource: TelemetryAttribute.AppErrorSource,
  errorType: TelemetryAttribute.ErrorType,
  artifactType: TelemetryAttribute.ArtifactType,
  artifactStatus: TelemetryAttribute.ArtifactStatus,
  syncBatchId: TelemetryAttribute.SyncBatchId,
} as const satisfies Record<
  keyof RequestCompletedSpanAttribution,
  keyof typeof SpanTelemetrySchema.shape
>;

/**
 * Project the resolved attribution onto span attributes, dropping any single
 * value the span schema rejects.
 *
 * Per-attribute validation is the point. `SpanTelemetrySchema` is `.strict()`,
 * so folding an unvalidated attribution value into the parse would let ONE bad
 * optional field — a blank org id, a status from a version-skewed producer —
 * fail the whole `safeParse` and silently drop `url.path`, `duration_ms`, and
 * the status code along with it. A bad optional value costs itself and nothing
 * else.
 */
function attributionAttributes(
  attribution: RequestCompletedSpanAttribution | undefined
): Record<string, string> {
  if (!attribution) {
    return {};
  }
  return {
    ...spanAttribute(
      SpanAttributionAttribute.organizationId,
      attribution.organizationId
    ),
    ...spanAttribute(SpanAttributionAttribute.userId, attribution.userId),
    ...spanAttribute(
      SpanAttributionAttribute.installationId,
      attribution.installationId
    ),
    ...spanAttribute(
      SpanAttributionAttribute.clientVersion,
      attribution.clientVersion
    ),
    ...spanAttribute(
      SpanAttributionAttribute.errorSource,
      attribution.errorSource
    ),
    ...spanAttribute(SpanAttributionAttribute.errorType, attribution.errorType),
    ...spanAttribute(
      SpanAttributionAttribute.artifactType,
      attribution.artifactType
    ),
    ...spanAttribute(
      SpanAttributionAttribute.artifactStatus,
      attribution.artifactStatus
    ),
    ...spanAttribute(
      SpanAttributionAttribute.syncBatchId,
      attribution.syncBatchId
    ),
  };
}

function spanAttribute(
  attribute: keyof typeof SpanTelemetrySchema.shape,
  value: string | undefined
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  return SpanTelemetrySchema.shape[attribute].safeParse(value).success
    ? { [attribute]: value }
    : {};
}

function logRequestCompletedContractFailure(
  reason: "build_failed" | "schema_validation_failed",
  error?: unknown
): void {
  try {
    log.warn("request_completed.contract build skipped", {
      reason,
      ...(error !== undefined && { error }),
      [TelemetryEmitMetadataKey.SchemaName]: TelemetrySchemaName.Span,
    });
  } catch {
    // Telemetry emission must not affect request handling.
  }
}
