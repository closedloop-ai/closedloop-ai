/**
 * ISS-6241 (ISS-4779 closed-by-default): desktop-only Labs flag surfacing the
 * real per-session count on the live Compute/derived-view maintenance step, so a
 * data-revision rebuild that legitimately runs for hours stops being
 * indistinguishable from a hang. Off by default; with it off both surfaces that
 * render the step name no population at all, exactly as today.
 *
 * Declared in this LEAF module — no imports, no registry — for the same reason
 * as `desktop-docs-help-flag.ts`: the E2E spec that drives this count through
 * the launched app has to seed the key, and importing `feature-flags.ts` from a
 * spec aborts the whole Playwright file at load (it reaches extensionless
 * `@repo/api/src/types/…` specifiers the ESM loader cannot resolve).
 *
 * IMPORT IT FROM HERE, not from `feature-flags.ts`: `noBarrelFile` forbids that
 * module re-exporting it, so it only imports it for its registry entry.
 */
export const DESKTOP_COMPUTE_PROGRESS_COUNT_FEATURE_FLAG_KEY =
  "compute-progress-count";
