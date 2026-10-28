/**
 * @file telemetry-event-payload.ts
 * @description ISS-7109/ISS-7201 — the cross-process boundary check that decides
 * whether a telemetry event raised in ANOTHER process can be carried by main's
 * transport, and, when it cannot, which field made it unroutable.
 *
 * Extracted from `telemetry-protocol.ts` (ISS-7201) so the one decision
 * procedure has a home of its own: that module owns the wire TYPES and sat at
 * the file-size ceiling, and this is behaviour, not shape.
 *
 * `classifyTelemetryEventPayloadRefusal` is the SSOT and
 * {@link isTelemetryEventPayload} is defined in terms of it, so the predicate
 * that ACCEPTS an event and the classifier that explains a REFUSAL can never
 * disagree about what "unroutable" means — a drift that would let main refuse an
 * event and then report a reason describing a different fault.
 */

import { z } from "zod";
import {
  DbHostTelemetryRefusalReason,
  type TelemetryDiagnostics,
  type TelemetryEventPayload,
  type TelemetrySeverity,
} from "./telemetry-protocol.js";

/**
 * ISS-7109 — the closed severity set as a runtime value, so a boundary that
 * receives an event from another PROCESS can check it without re-typing the
 * three literals the {@link TelemetrySeverity} union already owns. Adding a
 * member to that union fails `tsc` here until it is mapped.
 */
const TELEMETRY_SEVERITY_MEMBERS: Record<TelemetrySeverity, true> = {
  info: true,
  warn: true,
  error: true,
};

export function isTelemetrySeverity(
  value: unknown
): value is TelemetrySeverity {
  return (
    typeof value === "string" &&
    Object.hasOwn(TELEMETRY_SEVERITY_MEMBERS, value)
  );
}

/**
 * ISS-7201 — the primitive-typed members of {@link TelemetryDiagnostics}.
 *
 * Derived from the type rather than listed by hand, so adding a bare
 * `string`/`number` field to that type widens this key union and fails `tsc` at
 * {@link PRIMITIVE_DIAGNOSTICS_VALIDATORS} until the new field is mapped. That
 * is the compile-time keys-covered guard: the alternative — a hand-kept list —
 * is how a boundary schema silently stops covering the field that was just
 * added.
 */
type PrimitiveDiagnosticsKey = {
  [K in keyof TelemetryDiagnostics]-?: NonNullable<
    TelemetryDiagnostics[K]
  > extends string | number
    ? K
    : never;
}[keyof TelemetryDiagnostics];

/**
 * One validator per primitive diagnostics field. The `Record` annotation is
 * load-bearing, not decoration — it is what makes an unmapped new field a
 * compile error.
 */
const PRIMITIVE_DIAGNOSTICS_VALIDATORS: Record<
  PrimitiveDiagnosticsKey,
  z.ZodTypeAny
> = {
  exitCode: z.number().optional(),
  logTail: z.string().optional(),
  stderrTail: z.string().optional(),
  exitSignal: z.string().optional(),
  elapsedMs: z.number().optional(),
  stdoutBytes: z.number().optional(),
  abortReason: z.string().optional(),
  diagnosticsVersion: z.number().optional(),
  errorStack: z.string().optional(),
};

/**
 * ISS-7201 — the `diagnostics` bag as main's transport is willing to receive it.
 *
 * LOOSE on purpose, and that is the whole contract. `z.looseObject` keeps every
 * key this build has never heard of — a newer child's richer diagnostics must
 * still travel, which is the version-skew guarantee this module exists to hold —
 * while still type-checking the fields BOTH halves already agree on. A strict
 * schema here would reject the entire payload over one unknown key and reproduce
 * the silent whole-event drop one layer up.
 *
 * Scoped to the PRIMITIVE fields. The nested families (`spawnMeta`, `storePerf`,
 * `rendererHealth`, …) are deliberately not mirrored: re-declaring two dozen
 * nested shapes on this side of a boundary that has no shared import is exactly
 * the copy-drift this repo keeps paying for, and the nested bags are where a
 * newer child's shape legitimately evolves. The primitives are stable, are what
 * `TelemetryService.enrichEvent` actually dereferences, and are cheap to hold.
 */
const telemetryDiagnosticsBoundarySchema = z.looseObject(
  PRIMITIVE_DIAGNOSTICS_VALIDATORS
);

/**
 * ISS-7201 — why an event from the DB-host child could not be routed, or
 * `undefined` when it is routable.
 *
 * Checks the three fields the transport requires, plus the SHAPE of the known
 * primitive `diagnostics` fields. This runs at a cross-process boundary where
 * the peer may be a different build, and the failure mode being fixed is
 * telemetry vanishing in silence — so an unknown extra field, a richer
 * `diagnostics`, or a category this build has never heard of must all still
 * travel. What cannot travel is an event with no severity, no category, or no
 * message: those are unroutable, and the transport would turn them into a
 * whole-payload rejection downstream where nothing can attribute them back to
 * the process that raised them.
 *
 * The diagnostics check is not belt-and-braces. `TelemetryService.enrichEvent`
 * dereferences `logTail`/`stderrTail` through `Buffer.from`, which THROWS on a
 * structured-clone-safe `logTail: {}` — and `emit()` swallows that throw, so an
 * event whose only fault is a mistyped diagnostics field used to take the
 * refusal report down with it: main dropped the child's event AND never reported
 * the drop. Validating here converts that double silence into one attributable
 * `unknown_shape` refusal. The same value is a whole-event
 * `telemetry.validation_failed` at the ingest schema, so nothing that travels
 * today stops travelling; a loss that was silent becomes a loss that is counted.
 *
 * `category` is intentionally accepted as any non-empty string rather than
 * narrowed to the current `TelemetryCategory` union: the union is a main-process
 * compile-time contract, and rejecting a newer child's category here would drop
 * exactly the signal a newer child added.
 *
 * `severity` is NOT given the same latitude, and the asymmetry is deliberate: an
 * unrecognised category still routes and groups, while an unrecognised severity
 * has no meaning to the transport or to any monitor on top of it, and the wire
 * schema would reject the whole event downstream anyway. Refusing it here at
 * least leaves the drop where an operator can see it. Main and the DB-host child
 * are the same build in the same install, so a severity this side does not know
 * is not a shipping configuration.
 *
 * The reasons are ordered severity → category → message → diagnostics and
 * reported FIRST-FAULT-ONLY: an event missing all three routing fields is one
 * refusal attributed to `invalid_severity`, never three. A monitor grouped by
 * reason therefore counts refused EVENTS, not refused fields. `unknown_shape`
 * sits last so it means what it says — the routing fields were fine and the
 * diagnostics were not — rather than absorbing faults the earlier arms name
 * precisely.
 */
export function classifyTelemetryEventPayloadRefusal(
  value: unknown
): DbHostTelemetryRefusalReason | undefined {
  if (typeof value !== "object" || value === null) {
    return DbHostTelemetryRefusalReason.NotAnObject;
  }
  const candidate = value as {
    severity?: unknown;
    category?: unknown;
    message?: unknown;
    diagnostics?: unknown;
  };
  if (!isTelemetrySeverity(candidate.severity)) {
    return DbHostTelemetryRefusalReason.InvalidSeverity;
  }
  if (
    typeof candidate.category !== "string" ||
    candidate.category.length === 0
  ) {
    return DbHostTelemetryRefusalReason.MissingCategory;
  }
  if (typeof candidate.message !== "string") {
    return DbHostTelemetryRefusalReason.MissingMessage;
  }
  if (
    candidate.diagnostics !== undefined &&
    !telemetryDiagnosticsBoundarySchema.safeParse(candidate.diagnostics).success
  ) {
    return DbHostTelemetryRefusalReason.UnknownShape;
  }
  return undefined;
}

/**
 * ISS-7109 — is `value` an event the desktop telemetry transport can carry?
 *
 * Thin by construction: the accept/refuse decision lives entirely in
 * {@link classifyTelemetryEventPayloadRefusal}, so this predicate cannot drift
 * from the reason main reports when it drops the event.
 */
export function isTelemetryEventPayload(
  value: unknown
): value is TelemetryEventPayload {
  return classifyTelemetryEventPayloadRefusal(value) === undefined;
}
