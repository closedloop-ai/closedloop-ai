import { log } from "@repo/observability/log";
import { buildTelemetryTraceContext } from "@repo/observability/telemetry/context";
import { sanitizeDesktopTelemetryDiagnostics } from "@repo/observability/telemetry/emitter";
import { Origin } from "@repo/observability/telemetry/origin";
import {
  desktopTelemetryEventSchema,
  TelemetryCategory,
} from "@repo/observability/telemetry/schema";

export type TelemetryEmitInstruction = { event: string; payload: unknown };

export type TelemetryHandlerContext = {
  /**
   * The authenticated targetId for the connection.
   * Used to verify trace.computeTargetId matches.
   */
  authenticatedTargetId: string;
  /**
   * pluginVersion from the hello payload (direct-connect) or relay-forwarded body.
   * Not fetched from DB.
   */
  pluginVersion?: string;
  /**
   * gatewaySessionId forwarded by relay or from SocketConnectionContext.
   */
  gatewaySessionId?: string;
  /**
   * Server-enriched organizationId from the authenticated socket context.
   * NOT trusted from the desktop payload.
   */
  organizationId?: string;
  /**
   * Server-enriched userId from the authenticated socket context.
   * NOT trusted from the desktop payload.
   */
  userId?: string;
};

export type TelemetryHandlerResult =
  | { ok: true }
  | { ok: false; validationFailed: true; emits: TelemetryEmitInstruction[] };

/**
 * Shared handler for desktop.telemetry events.
 *
 * Validates the raw payload against desktopTelemetryEventSchema, verifies
 * trace.computeTargetId matches the authenticated targetId, sanitizes
 * diagnostics, then emits an enriched structured log.
 *
 * On validation failure, returns emits for telemetry.validation_failed with
 * only ZodIssue path/code/expected (no received values).
 *
 * Used by both:
 * - apps/api/app/internal/relay/socket-event/route.ts (relay path)
 * - apps/api/lib/desktop-gateway-socket-server.ts (direct-connect path)
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

    return {
      ok: false,
      validationFailed: true,
      emits: [
        {
          event: "telemetry.validation_failed",
          payload: { issues: safeIssues },
        },
      ],
    };
  }

  const event = parseResult.data;

  // Verify trace.computeTargetId matches authenticated targetId
  if (event.trace.computeTargetId !== context.authenticatedTargetId) {
    const safeIssues = [
      {
        path: ["trace", "computeTargetId"],
        code: "custom",
        expected: context.authenticatedTargetId,
      },
    ];

    log.warn("Desktop telemetry computeTargetId mismatch", {
      category: TelemetryCategory.TelemetryValidationFailed,
      authenticatedTargetId: context.authenticatedTargetId,
      traceComputeTargetId: event.trace.computeTargetId,
    });

    return {
      ok: false,
      validationFailed: true,
      emits: [
        {
          event: "telemetry.validation_failed",
          payload: { issues: safeIssues },
        },
      ],
    };
  }

  try {
    // Sanitize diagnostics (truncates logTail, strips credential lines)
    const sanitizedDiagnostics = sanitizeDesktopTelemetryDiagnostics(
      event.diagnostics
    );

    // Enrich trace with server-side context via buildTelemetryTraceContext.
    // pluginVersion comes from hello payload (not DB).
    // serverVersion and environment come from process env (resolved by the builder).
    const enrichedTrace = buildTelemetryTraceContext({
      ...event.trace,
      pluginVersion: context.pluginVersion,
      gatewaySessionId:
        context.gatewaySessionId ?? event.trace.gatewaySessionId,
    });

    log.info("Desktop telemetry event received", {
      schemaVersion: event.schemaVersion,
      category: event.category,
      severity: event.severity,
      timestamp: event.timestamp,
      trace: enrichedTrace,
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
      trace: event.trace,
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
      gatewaySessionId: event.trace?.gatewaySessionId,
      category: event.category,
      errorClass,
    });
  }

  return { ok: true };
}
