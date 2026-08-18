/**
 * @file e2e-parse-quarantine-seam.ts
 * @description ISS-4573: a TEST-ONLY seam that lets the launched-app Electron E2E
 * reach a nonzero `quarantinedCount` cheaply, so the "N transcripts couldn't be
 * read" caveat (ISS-4444) can be proven across the REAL boundary
 * (`CollectorManager` → runtime-status IPC → preload → `SessionsView` →
 * `SessionsSummaryCards`) rather than only in component render tests that inject
 * the runtime status at each end.
 *
 * Why a seam at all: quarantine only trips after `maxAttempts` (default 3) parse
 * passes that each wedge the worker turn for the full `HISTORICAL_PARSE_TIMEOUT_MS`
 * (~90s) — minutes of wall time, far over the e2e budget. This seam collapses that
 * to a single fast wedge.
 *
 * ⚠️ GATED BEHIND THE E2E LAUNCH ENV *AND* AN UNPACKAGED BUILD. This is NOT a
 * general operator env var / knob — ISS-4444 deliberately removed the
 * operator-configurable quarantine threshold (see `parse-quarantine.ts`), and this
 * must not re-introduce one. The launched E2E harness sets
 * {@link E2E_PARSE_QUARANTINE_ENV}; a production / operator run never sets it, so
 * `isE2eParseQuarantineEnabled()` is false and every consumer below is a no-op with
 * production defaults unchanged. The env value must be the exact
 * {@link E2E_PARSE_QUARANTINE_ENABLED_VALUE} sentinel, not merely "present", so an
 * unrelated stray value cannot accidentally flip the seam on.
 *
 * PR #4085 review (wongk): `process.env` is inherited by the packaged utility
 * process, so an env sentinel alone would let a PACKAGED client launched with the
 * flag quarantine a normal slow transcript after one 2s attempt (or wedge forever
 * on a marker-matching path). The seam therefore also requires an UNPACKAGED build:
 * the caller passes `isPackaged` (from Electron's `app.isPackaged` at the main-process
 * composition root), and a packaged build fails the gate no matter the env. The
 * utility-process worker cannot read `app.isPackaged` (the `app` module is
 * unavailable there), so the runner does not let the worker read the raw inherited
 * env — it forks the worker with the poison capability threaded in explicitly ONLY
 * after the main process cleared the unpackaged+sentinel gate (see
 * `utility-process-historical-parse-runner.ts`).
 *
 * Two consumers read this seam:
 *  1. The runtime (main process) checks `!app.isPackaged` + the sentinel, then
 *     tightens the manager's per-source parse deadline and drops the quarantine
 *     threshold to 1, so ONE wedged pass quarantines.
 *  2. The historical-parse worker (utility process) makes a seeded POISON
 *     transcript's parse never settle, so the low deadline above dead-letters it
 *     every pass — but ONLY when the main process explicitly forked it with the
 *     capability env set, never off a raw inherited value.
 */

/**
 * ISS-4573: the test-only launch env var the E2E harness sets to arm the seam. Not
 * an operator knob — a production launch never sets it. Read only through
 * {@link isE2eParseQuarantineEnabled}.
 */
export const E2E_PARSE_QUARANTINE_ENV = "CLOSEDLOOP_E2E_PARSE_QUARANTINE";

/**
 * The exact sentinel value {@link E2E_PARSE_QUARANTINE_ENV} must hold for the seam
 * to arm. Requiring an exact match (not mere presence) keeps a stray inherited
 * value from accidentally enabling the seam in a real run.
 */
export const E2E_PARSE_QUARANTINE_ENABLED_VALUE = "1";

/**
 * A seeded transcript whose absolute path contains this marker is treated by the
 * worker as a POISON source (its parse never settles) — but ONLY while the seam is
 * armed. The E2E seeds its poison transcript with this marker in the filename.
 */
export const E2E_POISON_TRANSCRIPT_MARKER = "closedloop-e2e-poison";

/**
 * PR #4085 review (wongk): the EXPLICIT worker capability env the main-process
 * runner sets on the forked utility process — distinct from
 * {@link E2E_PARSE_QUARANTINE_ENV}, which the operator/E2E harness sets on the
 * app. The worker cannot read `app.isPackaged`, so it must NOT trust the inherited
 * app-level sentinel; instead the runner, after clearing the `!isPackaged` +
 * sentinel gate in the main process, threads this capability in explicitly (and
 * strips any inherited value otherwise). The worker's poison check reads only this
 * key, so a packaged build (which never clears the main-process gate) can never
 * arm the worker.
 */
export const E2E_POISON_WORKER_CAPABILITY_ENV =
  "CLOSEDLOOP_E2E_PARSE_QUARANTINE_WORKER";

/**
 * ISS-4573: the tightened parse timing the runtime injects into the
 * `CollectorManager` while the seam is armed. A low per-source parse deadline so a
 * wedged poison transcript is dead-lettered in ~2s instead of ~90s, and a
 * quarantine threshold of 1 so that single wedge quarantines it immediately (so the
 * e2e never has to wait out multiple ~90s passes). Deliberately still a real,
 * non-zero deadline so a HEALTHY transcript parses well within it and is imported
 * normally.
 */
export const E2E_PARSE_QUARANTINE_CONFIG = {
  historicalParseTimeoutMs: 2000,
  parseQuarantineMaxAttempts: 1,
} as const;

/**
 * True only when the test-only E2E launch env is set to its exact enabled sentinel
 * AND the build is UNPACKAGED. `env` defaults to `process.env` so the main-process
 * call site reads the real environment; tests pass an explicit bag. `isPackaged`
 * defaults to `true` (fail-closed): a caller that cannot prove the build is
 * unpackaged never arms the seam. Fail-safe on both dimensions — any other env
 * value (absent, empty, unexpected) OR a packaged build returns false, so a real
 * run is never affected. PR #4085 review (wongk): the packaging gate stops a
 * packaged client launched with the inherited flag from quarantining a normal slow
 * transcript.
 */
export function isE2eParseQuarantineEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isPackaged = true
): boolean {
  return (
    !isPackaged &&
    env[E2E_PARSE_QUARANTINE_ENV] === E2E_PARSE_QUARANTINE_ENABLED_VALUE
  );
}

/**
 * True when the worker was EXPLICITLY forked with the poison capability
 * ({@link E2E_POISON_WORKER_CAPABILITY_ENV} set to the enabled sentinel) AND the
 * source path is a seeded poison transcript (its path carries
 * {@link E2E_POISON_TRANSCRIPT_MARKER}). The worker reads only the runner-supplied
 * capability, never the raw app-level sentinel it inherits, so a packaged build
 * (which never clears the main-process `!isPackaged` gate and so never sets this
 * capability) can never wedge a real parse. `env` defaults to `process.env` so the
 * worker call site reads its own environment; tests pass an explicit bag.
 */
export function isE2ePoisonSource(
  source: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    env[E2E_POISON_WORKER_CAPABILITY_ENV] ===
      E2E_PARSE_QUARANTINE_ENABLED_VALUE &&
    source.includes(E2E_POISON_TRANSCRIPT_MARKER)
  );
}
