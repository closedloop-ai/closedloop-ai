import {
  LIST_LOADING_STALL_THRESHOLDS,
  type LoadingStallThresholds,
} from "@repo/app/shared/hooks/use-loading-stall";

/**
 * FEA-3639 — the elapsed-time budget for a blocking Sessions-list load, tuned to
 * the ticket's ~10 s / ~30 s recommendations.
 *
 * It is NO LONGER A RENDER ESCALATION. This docblock described a `softMs`
 * "still loading… / Retry" affordance flipping at `hardMs` to a "temporarily
 * unavailable" error; ISS-11204 retired that, because elapsed time is not a
 * request failure — a blocking read past either threshold keeps the loading
 * treatment and offers no Retry (`dead-end-cause.ts`, and
 * `__tests__/sessions-view-loading-stall.test.tsx` pins the render). What is left
 * is a stall budget for telemetry and recovery TIMING, which is exactly what the
 * two hooks below read it for.
 *
 * ISS-10301 moved it out of `sessions-table-body.tsx`, whose v1 renderer the v2
 * surface retirement orphaned; the budget itself is unchanged and still read by
 * the recovery and dead-end-telemetry hooks.
 */
export const SESSIONS_LIST_STALL_THRESHOLDS: LoadingStallThresholds =
  LIST_LOADING_STALL_THRESHOLDS;
