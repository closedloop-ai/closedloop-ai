/**
 * The one invariant tying a launch route's request budget to the age at which a
 * PENDING loop is declared orphaned.
 *
 * Since ISS-5708 the launch routes await their dispatch, so a Loop row is
 * legitimately PENDING for as long as that request runs. `reapStalePendingLoops`
 * marks PENDING rows FAILED purely on age, and it runs on *every*
 * `loopsService.create` / `resume` for the same (artifactId, command) — so with
 * a reap threshold below the request budget, a retry from a second tab reaps a
 * launch that is still in flight. When that first dispatch then lands,
 * `claimOrPersistRunning` cannot transition FAILED → CLAIMED, `launchLoop`'s
 * catch runs `cleanupOnLaunchFailure`, and work the provider had already
 * accepted is torn back down.
 *
 * So: **the reap threshold must exceed the request budget.** Inside the budget
 * the launch route owns the row's fate — it cancels or fails it explicitly on
 * the way out — and the reaper is only the safety net for the case the route
 * cannot cover, which is the request being killed at its ceiling.
 *
 * Raising the threshold delays how quickly a genuinely dead dispatch stops
 * blocking the (artifactId, command) index slot. That is the deliberate trade:
 * a slower unblock for the rare truly-orphaned row, against never destroying a
 * dispatch the provider has already taken.
 */
export const LAUNCH_REQUEST_BUDGET_SECONDS = 60;

export const LAUNCH_REQUEST_BUDGET_MS = LAUNCH_REQUEST_BUDGET_SECONDS * 1000;

/**
 * Headroom over the request budget. Covers the gap between the platform killing
 * a function at its ceiling and the row actually stopping being written to, so
 * the reaper cannot race the tail of a launch that is only just over budget.
 */
const REAP_HEADROOM_MS = 15_000;

/**
 * Age beyond which a PENDING loop with no containerId is treated as an orphan
 * (silently-failed dispatch). Used by the reap step and by the
 * operationally-active lookup so the two stay in lockstep.
 *
 * Derived from `LAUNCH_REQUEST_BUDGET_MS` rather than written as a literal:
 * the two numbers are one invariant, and the previous 30s literal sat *below*
 * a 60s budget.
 */
export const STALE_PENDING_THRESHOLD_MS =
  LAUNCH_REQUEST_BUDGET_MS + REAP_HEADROOM_MS;
