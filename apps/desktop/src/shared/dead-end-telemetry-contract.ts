/**
 * @file dead-end-telemetry-contract.ts
 * @description ISS-7249: the renderer↔main dead-end payload. Zod-free because
 * the canonical sets live in `@closedloop-ai/telemetry-contract/app`, which
 * pulls in Zod, and the renderer bundle must not carry a parser to send closed
 * enums; the guard test pins the two declarations equal, and the contract holds
 * each rationale. Every field is a closed enum, a boolean, or a bounded count,
 * so the payload is a PII boundary by construction rather than by sanitizing.
 */

/** Renderer→main channel carrying one dead-end telemetry record. */
export const DEAD_END_TELEMETRY_CHANNEL = "desktop:dead-end-telemetry";

/** Mirrors `DeadEndTreatment` in `@closedloop-ai/telemetry-contract/app`. */
export const DeadEndFlowTreatment = {
  SessionsListStalled: "sessions_list_stalled",
  SessionsListUnavailable: "sessions_list_unavailable",
  SessionsListEmpty: "sessions_list_empty",
  SessionDetailStalled: "session_detail_stalled",
  SessionDetailNotFound: "session_detail_not_found",
  SessionDetailUnavailable: "session_detail_unavailable",
  BranchesListUnavailable: "branches_list_unavailable",
  BranchesListEmpty: "branches_list_empty",
  Unknown: "unknown",
} as const;

export type DeadEndFlowTreatment =
  (typeof DeadEndFlowTreatment)[keyof typeof DeadEndFlowTreatment];

/** `Rendered` fires once per render-with-cause — `use-dead-end-telemetry.ts`. */
export const DeadEndFlowPhase = {
  Rendered: "rendered",
  RetryAttempted: "retry_attempted",
  RetrySettled: "retry_settled",
} as const;

export type DeadEndFlowPhase =
  (typeof DeadEndFlowPhase)[keyof typeof DeadEndFlowPhase];

/** The five no-data states, which must stay five things here as on screen. */
export const DeadEndFlowState = {
  Loading: "loading",
  Unavailable: "unavailable",
  NotApplicable: "not_applicable",
  Unknown: "unknown",
  TrueZero: "true_zero",
} as const;

export type DeadEndFlowState =
  (typeof DeadEndFlowState)[keyof typeof DeadEndFlowState];

/** Why the surface reached its state — what the producer actually established. */
export const DeadEndFlowReason = {
  NotYetSynced: "not_yet_synced",
  Absent: "absent",
  FetchFailed: "fetch_failed",
  PermissionDenied: "permission_denied",
  LoadingThresholdExceeded: "loading_threshold_exceeded",
  FilteredOut: "filtered_out",
  Unclassified: "unclassified",
} as const;

export type DeadEndFlowReason =
  (typeof DeadEndFlowReason)[keyof typeof DeadEndFlowReason];

/** What the read a retry kicked off actually did. */
export const DeadEndFlowRetryOutcome = {
  Recovered: "recovered",
  StillDeadEnd: "still_dead_end",
} as const;

export type DeadEndFlowRetryOutcome =
  (typeof DeadEndFlowRetryOutcome)[keyof typeof DeadEndFlowRetryOutcome];

/**
 * What the surface was showing, independent of which phase is being reported.
 * `httpStatus` is OMITTED, never zero, when no response arrived.
 */
export type DeadEndTelemetryCause = {
  treatment: DeadEndFlowTreatment;
  state: DeadEndFlowState;
  reason: DeadEndFlowReason;
  retryOffered: boolean;
  httpStatus?: number;
};

/**
 * One dead-end record as the renderer sends it, DISCRIMINATED on `phase`
 * (ISS-7249, whitlockk review): `retryOutcome` is required on `retry_settled` and
 * forbidden on the other two. The flat shape this replaced let a caller build a
 * settled record with no outcome — which the runtime emitted incomplete — and an
 * outcome on `rendered`, which the runtime silently dropped. Either way the
 * retry funnel could not reconcile, so the two incoherent combinations are now
 * `tsc` errors here and parse rejections at the IPC boundary.
 */
export type DeadEndTelemetryPayload =
  | DeadEndRenderedTelemetryPayload
  | DeadEndSettledTelemetryPayload;

/** A state the user is looking at, or the retry they just pressed against it. */
export type DeadEndRenderedTelemetryPayload = DeadEndTelemetryCause & {
  phase:
    | typeof DeadEndFlowPhase.Rendered
    | typeof DeadEndFlowPhase.RetryAttempted;
  retryAttempt: number;
  retryOutcome?: never;
  /**
   * ISS-12039: `true` when the surface read the cloud API
   * (`DesktopAppCoreMode.Cloud`), whose reads write no `dead_end.rate` call
   * record, so its dead ends write none either. Absent means Local, the same
   * default as outside the app-core provider.
   */
  readsCloud?: boolean;
};

/** The settle, where the outcome is the whole point of the record. */
export type DeadEndSettledTelemetryPayload = DeadEndTelemetryCause & {
  phase: typeof DeadEndFlowPhase.RetrySettled;
  retryAttempt: number;
  retryOutcome: DeadEndFlowRetryOutcome;
};
