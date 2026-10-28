/**
 * @file agent-dashboard-runtime-import-schedule.ts
 * @description Cadence tunables for the desktop runtime's collector import and
 * startup background work.
 *
 * Split out of `agent-dashboard-design-system-runtime.ts`, which crossed the
 * 1,000-line ceiling once the ISS-6116 and ISS-6336 import-health seams landed
 * in the same wiring block.
 */

export const desktopHistoricalImportDelayMs = 0;
export const desktopHistoricalImportStaggerMs = 1000;
export const desktopCatchupPollMs = 30 * 60_000;

// FEA-2261: upper bound on how long the non-critical startup background tasks
// (catalog GitHub-stats fetch, enrichment sweep, historical backfill, catalog
// maintenance) wait for the first-launch collector import + post-boot
// maintenance to settle before falling open. Generous on purpose: a normal
// first launch resolves the real signal well inside this window, so this cap
// only protects the pathological case (no collectors, a stuck/crashed import)
// from deferring these best-effort ops indefinitely.
export const STARTUP_BACKGROUND_COLLECTOR_IMPORT_FAIL_OPEN_MS = 5 * 60_000;
