/**
 * PostHog flag for the pre-loop Cloud fallback (ISS-5171). Default off.
 *
 * Gates the *new* behaviour only: when a resolved Local compute target cannot be
 * reached, run the command on Cloud instead of hard-blocking it, and offer the
 * same escape hatch from the blocking dialog. The ISS-5169/ISS-5170 bug fixes
 * (relay-aware timeout budget, distinguishable failure reason, gate that cannot
 * wedge) are not gated — they restore already-intended behaviour.
 *
 * The pre-loop gate exists only on `apps/app`; `apps/desktop` has no
 * PreLoopSystemCheckProvider, so this is a single-surface gate with no desktop
 * Labs counterpart.
 */
export const PRE_LOOP_CLOUD_FALLBACK_FEATURE_FLAG_KEY =
  "pre-loop-cloud-fallback" as const;
