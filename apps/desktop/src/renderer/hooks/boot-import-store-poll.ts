/**
 * @file The one cadence at which a renderer surface re-reads the local SQLite
 * store WHILE the boot import is writing to it.
 *
 * Two surfaces ask the same question — the first-launch dashboard, waiting for
 * the session total to stop growing, and the guided-onboarding discovery step,
 * showing how many sessions have landed (ISS-10584). Both are polling a store
 * that a long first import holds open for writes, so the interval is answering
 * one contention question and had been answered twice with two copies of 2500.
 *
 * It lives in a constant-only module rather than on either consumer: a hook
 * importing a constant out of a component module would drag that component's
 * graph into every suite that mocks it, which is the hazard
 * `ingest-progress-terminal.ts` was split out to avoid.
 */

/**
 * Milliseconds between store reads during an unsettled boot import.
 *
 * Slow enough not to compete with the import's own writes, fast enough that a
 * count which advances per committed session reads as motion rather than as a
 * hang.
 */
export const BOOT_IMPORT_STORE_POLL_MS = 2500;
