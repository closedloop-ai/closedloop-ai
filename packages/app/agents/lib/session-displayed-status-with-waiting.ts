import {
  DISPLAYED_SESSION_STATUS,
  type DisplayedSessionStatus,
  resolveDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { toSessionInstant } from "@repo/app/agents/lib/session-duration";

/**
 * ISS-6455: the DISPLAYED status the Sessions LIST row and BOTH surfaces'
 * Duration derivations read — the shared `resolveDisplayedSessionStatus` folds,
 * with the awaiting-input projection running ahead of them.
 *
 * It is NOT what the session-detail TITLE CHIP reads. That one is
 * `resolveSessionDetailDisplayStatus`, whose Waiting projection is deliberately
 * WIDER (see below), so an unrecognized status carrying `awaitingInputSince`
 * still badges "Waiting" on the chip and "Unknown" in the list. That gap
 * pre-dates this module and is not the one it closes — narrowing here is what
 * keeps an unmeasurable run from being timed.
 *
 * It exists because the projection cannot live in only one surface. ISS-5575
 * unified the list and detail Duration on `resolveDisplayedSessionStatus`, then
 * the review that followed (wongk, #4971) added the awaiting-input projection to
 * the DETAIL alone — which re-opened the split for one population: a session
 * stored `active` with `awaitingInputSince` set and silent past the staleness
 * cutoff. The detail exempted it and kept timing; the list, which never read the
 * field, folded it to Stale and emptied its Duration cell. Both surfaces now
 * derive here, so that record cannot report two spans one click apart.
 *
 * That population is reachable, not theoretical: the desktop LOCAL list producer
 * (`buildLocalSessionTimingAndUsage`) puts `awaitingInputSince` on the row while
 * the status column stays raw `active` whenever the `sessions-displayed-status-parity`
 * Labs gate is off, which is its closed-by-default state. The local Status FACET
 * already returns that row from Waiting and excludes it from Stale
 * (`deriveRowDisplaySignals`), so projecting it here also stops the badge from
 * contradicting the filter that gathered it.
 *
 * The projection is narrowed to the raw statuses this build RECOGNIZES as live.
 * It must NOT be the sibling `resolveSessionDetailDisplayStatus`, whose Waiting
 * projection normalizes with `normalizeDisplayedSessionStatus` and so fail-opens
 * `unknown`, `stale`, and unrecognized values to `active` — a version-skewed
 * payload spelling `unknown` alongside `awaitingInputSince` would project to
 * `waiting` and start timing a run neither surface can measure.
 */
export function resolveDisplayedSessionStatusWithWaiting(input: {
  status: string;
  /**
   * Both temporal fields arrive RAW — a caller must not pre-parse them. This is
   * the one place that tells absent from unreadable (see
   * {@link projectLiveWaiting}), and a caller's own `null`-on-unparseable
   * normalization destroys that distinction before it gets here.
   */
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  /**
   * The instant the staleness cutoff is measured against, injected so the
   * derivation stays a pure function of its arguments and a caller can advance
   * it on a coarse tick instead of freezing at mount.
   */
  now?: Date;
}): DisplayedSessionStatus {
  const projection = projectLiveWaiting(input);
  if (projection === AwaitingInputEvidence.Waiting) {
    return DISPLAYED_SESSION_STATUS.WAITING;
  }
  if (projection === AwaitingInputEvidence.Unreadable) {
    return DISPLAYED_SESSION_STATUS.UNKNOWN;
  }
  return resolveDisplayedSessionStatus({
    lastActivityAt: input.lastActivityAt,
    now: input.now,
    // The `lastActivityAt ?? startedAt` anchor the write-side reaper uses, so a
    // row with no activity timestamp is not the one exempted from the fold.
    startedAt: input.startedAt,
    status: input.status,
  });
}

/**
 * ISS-5575 (wongk, #4971): the awaiting-input projection, narrowed to the raw
 * statuses this build RECOGNIZES as live.
 *
 * `awaitingInputSince` is a durable stored fact, and only the cloud read path
 * projects it into the status column — a desktop LOCAL row arrives as raw
 * `active` with the timestamp beside it unless the independent
 * `sessions-displayed-status-parity` Labs flag is on. Without this, such a run
 * folded to Stale after 24h and stopped its Duration while the detail title chip
 * (`resolveSessionDetailDisplayStatus`, which does see the field) kept reading
 * "Waiting". `waiting` is deliberately exempt from the staleness fold: a run that
 * asked for approval three days ago genuinely IS still awaiting input.
 *
 * The recognition test is `resolveDisplayedSessionStatus` with NO timestamps —
 * that applies the unrecognized fold while leaving the staleness fold no anchor
 * to fire on, so it answers only "does this build read this status as live".
 * `unknown`, `stale`, every unrecognized spelling, and every terminal value
 * answer no and are preserved verbatim, which is the fail-open this module
 * exists to avoid. The `endedAt` test comes with it for the ISS-4654 reason: a
 * straggler terminal row that still carries `awaitingInputSince` is not waiting.
 *
 * ISS-6455 (wongk, #5099 review): the timestamps themselves are read by the
 * shared {@link classifyAwaitingInputEvidence}, which keeps absent and
 * UNREADABLE apart; this adds only the recognized-live gate.
 *
 * The gate covers the `Unreadable` verdict too. A status this build does not
 * read as live is already preserved verbatim by the fold — an `inactive` row
 * says the run is over whatever its end INSTANT parses to — so disclaiming it
 * over a corrupt timestamp would throw away the one fact we do have.
 *
 * `waiting` stays DISPLAY vocabulary. This is a render-time derivation that
 * writes nothing and no producer reads (root `AGENTS.md`).
 */
function projectLiveWaiting(input: {
  status: string;
  awaitingInputSince?: Date | string | null;
  endedAt?: Date | string | null;
}): AwaitingInputEvidence {
  const evidence = classifyAwaitingInputEvidence(input);
  if (evidence === AwaitingInputEvidence.None) {
    return AwaitingInputEvidence.None;
  }
  const recognized = resolveDisplayedSessionStatus({ status: input.status });
  const live =
    recognized === SESSION_STATUS.ACTIVE ||
    recognized === DISPLAYED_SESSION_STATUS.WAITING;
  return live ? evidence : AwaitingInputEvidence.None;
}

/**
 * ISS-6455 (wongk, #5099 review): what a row's two awaiting-input timestamps
 * amount to, WITHOUT deciding whether this build reads the status as live.
 *
 * That last part is deliberately left out, and it is why this is shared rather
 * than duplicated: the two surfaces gate the projection differently on purpose —
 * the Duration derivations narrow it to a RECOGNIZED live status
 * ({@link projectLiveWaiting}), while the detail title chip is wider and only
 * excludes TERMINAL ones (`session-detail-display-status.ts`). What they must
 * NOT disagree about is the evidence itself. When they did, the chip badged
 * "Waiting" next to a Duration that had already given up on the same record.
 *
 * THE TWO FIELDS CARRY DIFFERENT WEIGHT, and conflating them is what a
 * truthiness test could not express:
 *
 *  - `endedAt` decides whether the run is OVER. Unreadable, this build cannot
 *    tell — so it answers `Unreadable`, and both consumers badge
 *    {@link DISPLAYED_SESSION_STATUS.UNKNOWN}, whose Duration window is
 *    `unmeasurable`. That is the em-dash rather than a span still growing
 *    against `now()` for a run that may well have finished (the ISS-4979 rule).
 *    It is checked FIRST and independently: the old shape only looked at
 *    `endedAt` once `awaitingInputSince` happened to be populated, so one
 *    corrupt end instant was fatal on one row and invisible on its twin.
 *  - `awaitingInputSince` decides only whether the run is EXEMPT from the
 *    staleness fold. Unreadable, there is no exemption to grant, so it answers
 *    `None` and the row takes the ordinary fold — Stale if it has been silent,
 *    measured if it has not. It must NOT disclaim the row: `status`,
 *    `startedAt` and `lastActivityAt` are all still intact, and throwing a
 *    perfectly measurable span away because ONE unrelated field is corrupt is
 *    the same over-claim in the other direction. The sibling convention is
 *    `resolveDisplayedSessionStatus`, which degrades a malformed
 *    `lastActivityAt` to the `startedAt` anchor rather than giving up on the row.
 *
 * A VALID `endedAt` settles it as `None` before the awaiting test runs at all:
 * the run is over (ISS-4654), so a straggler timestamp beside it is not a claim
 * that anyone is still waiting.
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
