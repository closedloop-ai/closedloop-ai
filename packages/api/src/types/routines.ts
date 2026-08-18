/**
 * Routines (PRD-566 / FEA-4348) — the desktop-originated "Scheduled Tasks"
 * feature, renamed to "Routines".
 *
 * The web nav/route/page are GATED behind the PostHog `routines` flag (default
 * off) until GA — belt-and-suspenders with the desktop Labs setting — so an
 * unfinished feature never surfaces in prod (FEA-4348). Each web nav surface
 * (sidebar, command palette) resolves this key in its own flag map, and the
 * `/routines` route wraps its content in `FeatureFlagRouteGate`. On the desktop,
 * the interactive scheduler is gated by a persisted Labs setting (a
 * `DesktopSettings` field, NOT PostHog — the desktop has no PostHog wiring),
 * renamed from the pre-existing `scheduledTasks` Labs toggle so an
 * already-opted-in scheduler is not stranded.
 *
 * This exported key is the canonical SSOT for that desktop Labs setting field
 * name (`"routines"`). The desktop main-process feature-flag registry
 * (`apps/desktop/src/shared/feature-flags.ts`) redeclares this exact literal
 * rather than importing it, to keep that module free of the `@repo/api`
 * transitive graph — the two must stay byte-for-byte equal.
 */
export const ROUTINES_FEATURE_FLAG_KEY = "routines" as const;
export type RoutinesFeatureFlagKey = typeof ROUTINES_FEATURE_FLAG_KEY;

/**
 * A single scheduled Routine as surfaced by the cloud `/routines` API.
 *
 * Routines are authored and run desktop-locally today (the crewd scheduler
 * daemon in `apps/desktop`), so the cloud list is currently a forward-looking,
 * flag-gated contract that returns an empty set until cloud-side persistence
 * lands. Fields are intentionally minimal and additive.
 */
export type Routine = {
  id: string;
  name: string;
};

/** Response shape of `GET /routines`. */
export type RoutinesListResponse = {
  routines: Routine[];
};
