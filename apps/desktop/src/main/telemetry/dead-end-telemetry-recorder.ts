/**
 * @file dead-end-telemetry-recorder.ts
 * @description ISS-7249: validate one renderer-supplied dead-end record and hand
 * it to the keyless-relay OTel runtime. Consent posture:
 * `sync-egress-gate.ts` governs SESSION DATA, not operational telemetry, whose
 * gate is `resolveDesktopTelemetryEgressEnabled` plus `OTEL_SDK_DISABLED` — and
 * a dead-end record carries no session data to gate.
 */
import {
  DeadEndPhase,
  DeadEndReason,
  DeadEndRetryOutcome,
  DeadEndState,
  DeadEndTreatment,
} from "@closedloop-ai/telemetry-contract/app";
import { z } from "zod";
import {
  DeadEndFlowPhase,
  DeadEndFlowReason,
  DeadEndFlowRetryOutcome,
  DeadEndFlowState,
  DeadEndFlowTreatment,
  type DeadEndRenderedTelemetryPayload,
  type DeadEndSettledTelemetryPayload,
} from "../../shared/dead-end-telemetry-contract.js";
import {
  type DesktopDeadEndEventInput,
  recordDeadEndRate,
} from "./app-otel-runtime-dead-end.js";

/** Sized against once-per-render-with-cause, not a raw render count. */
export const DEAD_END_TELEMETRY_MAX_RECORDS = 512;

/** The cause half, identical in both arms of the discriminated union below. */
const deadEndCauseShape = {
  treatment: z.enum(DeadEndTreatment),
  state: z.enum(DeadEndState),
  reason: z.enum(DeadEndReason),
  retryOffered: z.boolean(),
  retryAttempt: z.number().int().min(0),
  httpStatus: z.number().int().min(100).max(599).optional(),
};

/**
 * The two phases that report a state the user is LOOKING at. `retryOutcome` is
 * declared here as "absent or undefined" rather than left out of the shape: a
 * strict object would already reject the key as unknown, but naming it is what
 * lets the `satisfies` guard below prove every field of the payload type has a
 * validator — a new field then fails `tsc` instead of being rejected in
 * production.
 */
const deadEndRenderedPayloadSchema = z.strictObject({
  ...deadEndCauseShape,
  phase: z.literal([DeadEndPhase.Rendered, DeadEndPhase.RetryAttempted]),
  retryOutcome: z.undefined().optional(),
  readsCloud: z.boolean().optional(),
} satisfies Record<keyof DeadEndRenderedTelemetryPayload, z.ZodType>);

/** The settle, where the outcome is the whole point of the record. */
const deadEndSettledPayloadSchema = z.strictObject({
  ...deadEndCauseShape,
  phase: z.literal(DeadEndPhase.RetrySettled),
  retryOutcome: z.enum(DeadEndRetryOutcome),
} satisfies Record<keyof DeadEndSettledTelemetryPayload, z.ZodType>);

/**
 * Discriminated on `phase` (ISS-7249, whitlockk review): the flat schema this
 * replaced accepted `retry_settled` with no `retryOutcome` and accepted a
 * `retryOutcome` on `rendered`/`retry_attempted`. The runtime emitted the first
 * incomplete and silently dropped the second, so the retry funnel could not
 * reconcile attempts against outcomes. Both are now rejections.
 *
 * Strict, not passthrough, because the two sides of this boundary ship in ONE
 * Electron build: there is no version skew to tolerate, `tsc` catches a new
 * field before it can be sent, and the closed-world parse is what makes "no
 * identifier, name, or path can ride a dead-end record" a property of the
 * boundary rather than of a downstream sanitizer.
 */
const deadEndTelemetryPayloadSchema = z.discriminatedUnion("phase", [
  deadEndRenderedPayloadSchema,
  deadEndSettledPayloadSchema,
]);

export type DeadEndTelemetryRecorder = {
  /** Validate and emit one record. Returns whether it reached the runtime. */
  record: (payload: unknown) => boolean;
};

export type DeadEndTelemetryDeps = {
  /**
   * Reports whether the record reached the runtime (ISS-7249, review cid
   * 3821326107). A `void` sink here would make `record`'s own contract — and the
   * `{ ok }` the renderer is answered — unable to tell a delivery from a silent
   * drop before `start()`.
   */
  emit: (input: DesktopDeadEndEventInput) => boolean;
  /** Override only in tests that need to reach the cap without 512 calls. */
  maxRecords?: number;
};

export function createDeadEndTelemetryRecorder(
  deps: DeadEndTelemetryDeps
): DeadEndTelemetryRecorder {
  const maxRecords = deps.maxRecords ?? DEAD_END_TELEMETRY_MAX_RECORDS;
  let emitted = 0;
  return {
    record(payload) {
      const parsed = deadEndTelemetryPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return false;
      }
      // ISS-12039: the rate record is written before the cap, so the 513th
      // dead end still counts while its detailed record is dropped.
      recordDeadEndRate(parsed.data);
      if (emitted >= maxRecords) {
        return false;
      }
      const delivered = deps.emit(parsed.data);
      if (!delivered) {
        // A record the runtime dropped is not an emitted record. Counting it
        // would burn the cap on signal that never shipped — the same reason a
        // rejected payload is not counted.
        return false;
      }
      // Counted only once the parse succeeded AND the runtime took it, or
      // rejected/dropped payloads would report as emitted records.
      emitted += 1;
      return true;
    },
  };
}

/**
 * Exported for the guard test that asserts exact set equality in both
 * directions. Declaring the values twice keeps Zod out of the renderer bundle;
 * the test is what stops them drifting apart.
 */
export const DEAD_END_RENDERER_VALUE_SETS = {
  treatment: [DeadEndFlowTreatment, DeadEndTreatment],
  phase: [DeadEndFlowPhase, DeadEndPhase],
  state: [DeadEndFlowState, DeadEndState],
  reason: [DeadEndFlowReason, DeadEndReason],
  retryOutcome: [DeadEndFlowRetryOutcome, DeadEndRetryOutcome],
} as const;
