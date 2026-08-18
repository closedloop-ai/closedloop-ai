/**
 * ISS-6206 (ISS-4779 closed-by-default): desktop-only Labs flag gating the
 * honest whole-app cloud-readiness verdict. Default OFF, so an installed build
 * keeps exactly the behavior it shipped with.
 *
 * When ON, `resolveCloudSyncBacklog` requires each lane's CANONICAL drain state
 * before the app may claim it is caught up — a `never_started` or
 * `idle_not_running` lane sitting at a measured zero reads as "Checking…"
 * instead of "Up to date" — and the outstanding-backlog copy reports per-lane
 * counts instead of one cross-lane total whose units do not add up. Both are
 * user-perceivable, so they share one gate rather than shipping half-on.
 *
 * Desktop-only surface: the cloud-readiness snapshot comes from the local
 * gateway's burn-down reporter over IPC and has no `apps/app` analogue, so there
 * is no PostHog counterpart to keep in parity.
 *
 * Declared in this LEAF module — no imports, no registry — for the same reason
 * `desktop-docs-help-flag.ts` is: the launched-Electron specs that prove the
 * flag selection actually reaches the renderer need this key, and
 * `feature-flags.ts` reaches its registry through extensionless
 * `@repo/api/src/types/…` specifiers that Playwright's ESM loader cannot
 * resolve — importing the registry from a spec aborts the whole file at load.
 *
 * IMPORT IT FROM HERE, not from `feature-flags.ts`: `noBarrelFile` forbids that
 * module re-exporting it, so it only imports it for its registry entry.
 */
export const DESKTOP_STOPPED_LANE_READINESS_FEATURE_FLAG_KEY =
  "stoppedLaneReadiness";
