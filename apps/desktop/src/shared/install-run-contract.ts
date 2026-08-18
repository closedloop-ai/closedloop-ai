/**
 * @file install-run-contract.ts
 * @description The pack install/uninstall RUN CONTRACT: the harness sentinel,
 * the closed error-code vocabulary, their retry-eligibility, and the result
 * shape.
 *
 * Deliberately a leaf module with zero imports, and deliberately in `shared/`
 * rather than `main/packs/`, for two reasons:
 *
 *  1. `install-orchestrator.ts` — a producer of these values — transitively
 *     reaches `catalog-store.ts` and the Prisma client, which the
 *     `boot-no-design-system-runtime` dependency-cruiser rule forbids any
 *     boot-path file from reaching statically. Boot-path consumers such as
 *     `required-plugin-installer.ts` need a VALUE import of the sentinel and the
 *     error codes that does not drag the orchestrator (and the db) onto the
 *     eager boot graph.
 *  2. The renderer sends the sentinel too (the catalog Install action and the
 *     opt-in banner), and the renderer cannot import from `main/`.
 *
 * One canonical definition on both sides of both boundaries, instead of a
 * literal re-declared per call site.
 */

/**
 * Sentinel harness id meaning "main picks the concrete harness(es)". It is NOT
 * a harness id and never appears as a key in a catalog entry's command maps.
 *
 * Every caller that does not have an explicit user-chosen harness sends this:
 * the renderer catalog install action, the opt-in banner, and the distribution
 * auto-installer. Resolution lives in exactly one place —
 * `resolveAutoCommand` in `main/packs/install-command-resolver.ts` — so a pack
 * class can never be silently unreachable the way non-`single_install` packs
 * were before ISS-5027.
 */
export const HARNESS_AUTO = "auto";

/**
 * The closed vocabulary of error codes `streamRun` emits on a non-started run.
 * Exported so the convert engine's transient/permanent classifier can be pinned
 * exhaustive against the PRODUCER's own codes (rather than duplicating loose
 * string literals): a new code added here without a classification lands the
 * engine's exhaustiveness guard, not a silent transient fallthrough.
 *
 *  - `ENOTFOUND`    — pack id not in the catalog.
 *  - `ENOCOMMAND`   — no install/uninstall command for the requested harness.
 *  - `ENOCLI`       — no supported harness CLI on PATH (auto-harness resolution).
 *  - `EBADCWD`      — the requested cwd failed validation.
 *  - `EINFLIGHT`    — another run for the same pack is already in-flight.
 *  - `ECWDREQUIRED` — a project-scoped pack was launched without an explicit cwd.
 */
export const StreamRunErrorCode = {
  NotFound: "ENOTFOUND",
  NoCommand: "ENOCOMMAND",
  NoCli: "ENOCLI",
  BadCwd: "EBADCWD",
  InFlight: "EINFLIGHT",
  CwdRequired: "ECWDREQUIRED",
} as const;
export type StreamRunErrorCode =
  (typeof StreamRunErrorCode)[keyof typeof StreamRunErrorCode];

export type StreamRunResult = {
  started: boolean;
  runId?: number;
  error?: { code: StreamRunErrorCode; message: string };
};

/**
 * Whether repeating the SAME request could ever succeed.
 * - `transient` — the condition is outside the request (no CLI yet, another run
 *   in flight); a later retry is meaningful.
 * - `permanent` — this input cannot succeed however many times it is retried.
 */
export const StreamRunRetryClass = {
  Transient: "transient",
  Permanent: "permanent",
} as const;
export type StreamRunRetryClass =
  (typeof StreamRunRetryClass)[keyof typeof StreamRunRetryClass];

/**
 * Retry-eligibility of EVERY {@link StreamRunErrorCode}, as an exhaustive
 * `Record` keyed off the producer's own vocabulary — a NEW code added above
 * without an entry here fails `tsc` rather than quietly defaulting.
 *
 * This is the single source for the axis. The convert engine derives its
 * `ConvertFailureClass` from it, and the distribution installer derives its log
 * LEVEL from it, so the two cannot drift into disagreeing about what counts as
 * a real failure.
 */
const STREAM_RUN_RETRY_CLASS: Record<StreamRunErrorCode, StreamRunRetryClass> =
  {
    [StreamRunErrorCode.NoCli]: StreamRunRetryClass.Transient,
    [StreamRunErrorCode.InFlight]: StreamRunRetryClass.Transient,
    [StreamRunErrorCode.NotFound]: StreamRunRetryClass.Permanent,
    [StreamRunErrorCode.NoCommand]: StreamRunRetryClass.Permanent,
    [StreamRunErrorCode.BadCwd]: StreamRunRetryClass.Permanent,
    [StreamRunErrorCode.CwdRequired]: StreamRunRetryClass.Permanent,
  };

/**
 * Classify a `streamRun` error code onto the retry axis. An unrecognized code
 * (an older/newer peer producing a code this build does not know) degrades to
 * `transient` — the version-skew-safe default: treat an unknown code as
 * retryable rather than wrongly declaring a permanent dead end.
 */
export function classifyStreamRunRetry(
  code: string | undefined
): StreamRunRetryClass {
  if (code && code in STREAM_RUN_RETRY_CLASS) {
    return STREAM_RUN_RETRY_CLASS[code as StreamRunErrorCode];
  }
  return StreamRunRetryClass.Transient;
}
