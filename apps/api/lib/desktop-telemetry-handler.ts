import { log } from "@repo/observability/log";
import {
  redactGatewaySessionId,
  redactTraceGatewaySessionId,
} from "@repo/observability/redact-correlation";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { sanitizeDesktopTelemetryDiagnostics } from "@repo/observability/telemetry/emitter";
import { Origin } from "@repo/observability/telemetry/origin";
import { desktopTelemetryEventSchema } from "@repo/observability/telemetry/schema";
import { TelemetryCategory } from "@repo/observability/telemetry/telemetry-category";

export type TelemetryHandlerContext = {
  /**
   * The authenticated targetId for the connection.
   * Used to verify trace.computeTargetId matches.
   */
  authenticatedTargetId: string;
  /**
   * pluginVersion as the caller received it. Not fetched from DB.
   */
  pluginVersion?: string;
  /**
   * Server-enriched organizationId from the authenticated request.
   * NOT trusted from the desktop payload.
   */
  organizationId?: string;
  /**
   * Server-enriched userId from the authenticated request.
   * NOT trusted from the desktop payload.
   */
  userId?: string;
};

export type TelemetryHandlerResult = { ok: true } | { ok: false };

/**
 * Handler for Desktop telemetry events posted to `POST /desktop/telemetry`.
 *
 * Validates the raw payload against desktopTelemetryEventSchema, verifies
 * trace.computeTargetId matches the authenticated targetId, sanitizes
 * diagnostics, then emits an enriched structured log.
 *
 * On validation failure, logs telemetry.validation_failed with only ZodIssue
 * path/code/expected (no received values) and returns `ok: false`.
 */
export function handleTelemetryEvent(
  payload: unknown,
  context: TelemetryHandlerContext
): TelemetryHandlerResult {
  // Validate against DesktopTelemetryEvent schema (transforms trace.sessionId → loopSessionId)
  const parseResult = desktopTelemetryEventSchema.safeParse(payload);

  if (!parseResult.success) {
    const safeIssues = parseResult.error.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
      expected:
        "expected" in issue
          ? (issue as { expected: unknown }).expected
          : undefined,
    }));

    log.warn("Desktop telemetry validation failed", {
      category: TelemetryCategory.TelemetryValidationFailed,
      authenticatedTargetId: context.authenticatedTargetId,
      issues: safeIssues,
    });

    return { ok: false };
  }

  const event = parseResult.data;

  // Verify trace.computeTargetId matches authenticated targetId
  if (event.trace.computeTargetId !== context.authenticatedTargetId) {
    log.warn("Desktop telemetry computeTargetId mismatch", {
      category: TelemetryCategory.TelemetryValidationFailed,
      authenticatedTargetId: context.authenticatedTargetId,
      traceComputeTargetId: event.trace.computeTargetId,
    });

    return { ok: false };
  }

  try {
    // Sanitize diagnostics (truncates logTail, strips credential lines)
    const sanitizedDiagnostics = sanitizeDesktopTelemetryDiagnostics(
      event.diagnostics
    );

    // Enrich trace with server-side context via buildTelemetryTraceContext.
    // pluginVersion comes from the caller (not DB).
    // serverVersion and environment come from process env (resolved by the builder).
    const enrichedTrace = buildTelemetryTraceContext({
      ...event.trace,
      pluginVersion: context.pluginVersion,
    });

    log.info("Desktop telemetry event received", {
      schemaVersion: event.schemaVersion,
      category: event.category,
      severity: event.severity,
      timestamp: event.timestamp,
      // gatewaySessionId is hashed before logging; the raw token stays in the
      // store/DB context, never in a log sink.
      trace: redactTraceGatewaySessionId(enrichedTrace),
      ...(sanitizedDiagnostics !== undefined && {
        diagnostics: sanitizedDiagnostics,
      }),
      ...(event.message !== undefined && { telemetryMessage: event.message }),
      ...(event.errorClass !== undefined && { errorClass: event.errorClass }),
      origin: Origin.Desktop,
      ...(context.organizationId !== undefined && {
        organizationId: context.organizationId,
      }),
      ...(context.userId !== undefined && { userId: context.userId }),
    });
  } catch (error) {
    const errorClass =
      error instanceof Error ? error.constructor.name : "UnknownError";

    // Fallback: emit the original event data so the event is never dropped.
    // Origin is structurally known (the event passed desktop-schema validation);
    // only trace enrichment failed. The accompanying telemetry.enrichment_failed
    // warning carries the degradation signal.
    log.info("Desktop telemetry event received", {
      schemaVersion: event.schemaVersion,
      category: event.category,
      severity: event.severity,
      timestamp: event.timestamp,
      trace: redactTraceGatewaySessionId(event.trace),
      ...(event.message !== undefined && { telemetryMessage: event.message }),
      ...(event.errorClass !== undefined && { errorClass: event.errorClass }),
      origin: Origin.Desktop,
      ...(context.organizationId !== undefined && {
        organizationId: context.organizationId,
      }),
      ...(context.userId !== undefined && { userId: context.userId }),
    });

    // Structured warning — only bounded-cardinality fields, no PII.
    log.warn("telemetry.enrichment_failed", {
      commandId: event.trace?.commandId,
      gatewaySessionIdHash: redactGatewaySessionId(
        event.trace?.gatewaySessionId
      ),
      category: event.category,
      errorClass,
    });
  }

  return { ok: true };
}
