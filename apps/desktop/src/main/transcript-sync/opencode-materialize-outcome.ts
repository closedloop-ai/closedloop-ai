/**
 * @file opencode-materialize-outcome.ts
 * @description ISS-8600: how a settled OpenCode materialize pass NAMES its
 * outcome, and which of those names is owed an import-health record.
 *
 * The runner funnels a timeout, a worker exit, a worker error, a pass throw, an
 * unintelligible response AND a deliberate `stop()` through one rejection path,
 * so before this module the six were distinguishable only by message text. That
 * matters far more than it looks: `stopMaterialize` is called from
 * `TranscriptSyncService.stop()` on the ISS-4903 shutdown path, so a classifier
 * that read every rejection as a failure would emit `materialize_failed` on
 * every clean quit with a pass in flight — a fleet-wide false alarm on the exact
 * liveness signal ISS-8600 buys.
 *
 * A message-string discriminator is not an acceptable substitute here. The
 * cancel arm's correctness IS the point, and matching on prose breaks silently
 * the first time somebody rewords a log line.
 *
 * It lives HERE rather than in the runner because the discovery sweep is the
 * consumer and the runner statically imports `electron`; a sweep that reached
 * for the reason through the runner would drag `utilityProcess` into every
 * context that only wanted to classify an error.
 */
import { ImportHealthEvent } from "@closedloop-ai/telemetry-contract/app";
import type { MaterializeImportHealthEvent } from "../telemetry/app-otel-runtime-import-health.js";

/**
 * The four arms a materialize pass settles on. A clean pass resolves and is the
 * fourth — it has no reason because there is nothing to name.
 */
export const OpencodeMaterializeFailure = {
  /** The worker outran `materializeTimeoutMs`. */
  TimedOut: "timed_out",
  /** The worker exited, errored, threw, or answered unintelligibly. */
  Failed: "failed",
  /**
   * `stop()` cancelled the in-flight pass. A teardown, not a failure — the
   * ISS-4903 shutdown contract requires exactly this rejection, so it is the
   * arm that must stay silent.
   */
  Canceled: "canceled",
} as const;

/** Literal union of materialize failure reasons. */
export type OpencodeMaterializeFailure =
  (typeof OpencodeMaterializeFailure)[keyof typeof OpencodeMaterializeFailure];

/**
 * The rejection a materialize pass produces, carrying its reason alongside the
 * message the sweep already logs.
 *
 * Still an `Error`, deliberately: the ISS-4903 shutdown contract and every
 * existing caller see the same rejected type they always did, and the
 * discriminator rides along rather than replacing it.
 */
export class OpencodeMaterializeError extends Error {
  readonly reason: OpencodeMaterializeFailure;
  /**
   * True when this rejection was observed by a caller that JOINED an already
   * in-flight pass rather than starting one — see
   * {@link joinedMaterializeRejection}. Not a fifth reason: a follower's pass
   * failed for exactly the reason the owner's did, and this says only who is
   * owed the record for it.
   */
  readonly joined: boolean;

  constructor(
    reason: OpencodeMaterializeFailure,
    message: string,
    options?: { joined?: boolean }
  ) {
    super(message);
    this.name = "OpencodeMaterializeError";
    this.reason = reason;
    this.joined = options?.joined ?? false;
  }
}

/**
 * The import-health value each reason warrants — `null` where the honest report
 * is no report at all.
 *
 * An exhaustive `Record` rather than a switch with a default: a fifth reason
 * added without a decision fails `tsc` here, where the alternative is a new arm
 * quietly inheriting whichever branch the default happened to be.
 */
const MATERIALIZE_IMPORT_HEALTH_EVENTS: Record<
  OpencodeMaterializeFailure,
  MaterializeImportHealthEvent | null
> = {
  [OpencodeMaterializeFailure.TimedOut]: ImportHealthEvent.MaterializeTimedOut,
  [OpencodeMaterializeFailure.Failed]: ImportHealthEvent.MaterializeFailed,
  [OpencodeMaterializeFailure.Canceled]: null,
};

/**
 * The import-health record a rejected materialize pass is owed, or `undefined`
 * when it is owed none.
 *
 * An unrecognized rejection reports `materialize_failed`. That is the fail-safe
 * direction and not a guess: the ONLY silent arms are a cancel and a follower's
 * copy of somebody else's rejection, both of which are constructed here — so an
 * unreasoned rejection is a pass that genuinely ended without fresh
 * projections, whoever threw it.
 */
export function importHealthEventForMaterializeRejection(
  error: unknown
): MaterializeImportHealthEvent | undefined {
  if (!(error instanceof OpencodeMaterializeError)) {
    return ImportHealthEvent.MaterializeFailed;
  }
  if (error.joined) {
    return undefined;
  }
  return MATERIALIZE_IMPORT_HEALTH_EVENTS[error.reason] ?? undefined;
}

/**
 * Re-throwable copy of a pass rejection for a caller that JOINED that pass,
 * marked so it reports nothing.
 *
 * The runner single-flights the PASS, not the await: an overlapping sweep gets
 * the owner's promise back, so on a rejection EVERY waiter runs the sweep's
 * catch and every one of them would file a record. Two sweeps overlap routinely
 * — the start path kicks one and a tier/policy change kicks another, and
 * `sweepOnce` has no single-flight of its own — so one failed pass would arrive
 * as N, inflating the very count this signal exists to be counted by.
 *
 * A marker rather than a fifth {@link OpencodeMaterializeFailure}: the reason is
 * still the owner's reason, which is what the sweep's log line should say, and a
 * synthetic reason would have to be taught to every consumer that switches on
 * one. The owner is guaranteed to report, because it awaits the same rejection
 * through the same catch.
 */
export function joinedMaterializeRejection(
  error: unknown
): OpencodeMaterializeError {
  if (error instanceof OpencodeMaterializeError) {
    return new OpencodeMaterializeError(error.reason, error.message, {
      joined: true,
    });
  }
  return new OpencodeMaterializeError(
    OpencodeMaterializeFailure.Failed,
    error instanceof Error ? error.message : String(error),
    { joined: true }
  );
}
