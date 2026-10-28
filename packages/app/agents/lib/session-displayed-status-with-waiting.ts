import {
  type DisplayedSessionStatus,
  resolveDisplayedSessionStatus,
} from "@repo/api/src/types/session-status";
import { toSessionInstant } from "@repo/app/agents/lib/session-duration";

/**
 * ISS-6455: the DISPLAYED status the Sessions LIST row and BOTH surfaces'
 * Duration derivations read.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired the Waiting/Unknown
 * projection this function used to run ahead of
 * {@link resolveDisplayedSessionStatus}: `awaitingInputSince` no longer has a
 * display word of its own, and an unreadable `endedAt` folds through the
 * ordinary unrecognized-value path like everything else. This is now a thin
 * alias of the shared resolver, kept under its own name because the Duration
 * derivations on both surfaces call it specifically and a rename would touch
 * every one of those call sites for no behavior change.
 */
export function resolveDisplayedSessionStatusWithWaiting(input: {
  status: string;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  now?: Date;
}): DisplayedSessionStatus {
  return resolveDisplayedSessionStatus({
    lastActivityAt: input.lastActivityAt,
    now: input.now,
    startedAt: input.startedAt,
    status: input.status,
  });
}

/**
 * ISS-6455 (whitlockk, #5099 review): what a row's two awaiting-input timestamps
 * amount to — `endedAt` deciding whether the run is OVER, `awaitingInputSince`
 * deciding only whether it is awaiting input, each read independently so one
 * corrupt field cannot swallow the other's evidence.
 *
 * ISS-10364 retired this evidence's only reader on the Duration side: the
 * Duration derivations no longer narrow on a recognized-live status ahead of
 * the fold (see {@link resolveDisplayedSessionStatusWithWaiting} above). The
 * sole remaining consumer is the web Sessions list's polling gate
 * (`sessions-active-refetch.ts`), which excludes a run blocked on a human
 * because its server-owned fields cannot move until someone answers it.
 *
 * A VALID `endedAt` settles it as `None` before the awaiting test runs at all:
 * the run is over (ISS-4654), so a straggler timestamp beside it is not a claim
 * that anyone is still waiting. An UNREADABLE `endedAt` answers `Unreadable`
 * rather than falling through to the awaiting test, because "this build cannot
 * tell if the run ended" is not the same claim as "it did not".
 */
export function classifyAwaitingInputEvidence(input: {
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
}): AwaitingInputEvidence {
  const ended = classifyInstant(input.endedAt);
  if (ended === InstantEvidence.Invalid) {
    return AwaitingInputEvidence.Unreadable;
  }
  if (ended === InstantEvidence.Valid) {
    return AwaitingInputEvidence.None;
  }
  return classifyInstant(input.awaitingInputSince) === InstantEvidence.Valid
    ? AwaitingInputEvidence.Waiting
    : AwaitingInputEvidence.None;
}

/** The verdict {@link classifyAwaitingInputEvidence} reaches. */
export const AwaitingInputEvidence = {
  /** Not an awaiting-input row — take the ordinary displayed-status fold. */
  None: "none",
  Waiting: "waiting",
  /** The evidence is present but corrupt, so this build knows nothing. */
  Unreadable: "unreadable",
} as const;

export type AwaitingInputEvidence =
  (typeof AwaitingInputEvidence)[keyof typeof AwaitingInputEvidence];

/** The three states one wire timestamp can be in. */
const InstantEvidence = {
  Absent: "absent",
  Valid: "valid",
  Invalid: "invalid",
} as const;

type InstantEvidence = (typeof InstantEvidence)[keyof typeof InstantEvidence];

/**
 * An empty string is ABSENT, not corrupt — a producer that serializes a missing
 * timestamp as `""` is omitting it, and the truthiness test this replaces read
 * it that way too.
 */
function classifyInstant(
  value: Date | string | null | undefined
): InstantEvidence {
  if (value == null || value === "") {
    return InstantEvidence.Absent;
  }
  return toSessionInstant(value) === null
    ? InstantEvidence.Invalid
    : InstantEvidence.Valid;
}
