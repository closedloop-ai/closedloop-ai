import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  resolveSessionDurationDetail,
  type SessionDurationWindow,
} from "@repo/app/agents/lib/session-duration";
import { safeFormatDateTime } from "./session-datetime-format";

/**
 * ISS-4979 (#4291 review): the Duration MetricCard caption when the span is
 * absent, replacing the bounds caption {@link resolveSessionDurationDetail}
 * names on the two measurable branches.
 *
 * Same move the Events card beside it already makes with
 * {@link EVENT_RATE_UNAVAILABLE}: once the value slot can go empty, keeping the
 * measured-span caption underneath it still claims a measurement nothing made —
 * it names the two bounds the number was supposedly taken between, for a number
 * that does not exist. The caption states the absence instead.
 */
export const DURATION_UNRECORDED_DETAIL = "Length not recorded";

/**
 * ISS-4675: the Events MetricCard caption when the rate has no measurable
 * denominator — an unresolvable duration, or a measured zero-length span.
 *
 * It is a SENTENCE, not an omission. The Duration card sitting beside the Events
 * card is driven by the same span, so it drops to its no-data slot on exactly
 * the same input; dropping this caption too left two cards quiet at once with
 * nothing on screen saying why either went quiet.
 */
export const EVENT_RATE_UNAVAILABLE = "Rate unavailable";

/**
 * ISS-5131: the Duration MetricCard caption, derived from the SAME window that
 * produced the value it sits under — the repo rule that a status and its label
 * come from one helper, so two parallel switches cannot drift.
 *
 * The VALUE decides the absent branch, not the window alone: a measurable window
 * still yields no number when the start bound is missing or unparseable, and
 * captioning that empty slot "Start to end" would name the two bounds of a
 * measurement nothing made. Both Duration cards on this screen (the metric strip
 * and the Overview card) call this, so they can never state an absent span two
 * different ways.
 */
export function resolveDurationCaption(
  window: SessionDurationWindow,
  value: string | null
): string {
  if (value === null) {
    return DURATION_UNRECORDED_DETAIL;
  }
  return resolveSessionDurationDetail(window) ?? DURATION_UNRECORDED_DETAIL;
}

/**
 * ISS-5131 (whitlockk, #4409): the "Ended" metadata value, read off the SAME
 * {@link SessionDurationWindow} the Duration cards used, so the two facts on one
 * screen cannot contradict each other.
 *
 * `running` says so regardless of whether a stale `endedAt` is still on the row;
 * `unmeasurable` — terminal with no end instant — states the absence rather than
 * borrowing "Still running", which claimed a lifecycle the status had already
 * ruled out. {@link END_UNRECORDED_VALUE} is deliberately its own string and not
 * {@link DURATION_UNRECORDED_DETAIL}: that one describes a missing LENGTH under
 * a Duration card, and this slot is a missing INSTANT.
 */
export function resolveEndedMetadataValue(
  session: Pick<AgentSessionDetail, "endedAt">,
  window: SessionDurationWindow
): string {
  if (window.kind === "running") {
    return STILL_RUNNING_VALUE;
  }
  return session.endedAt
    ? safeFormatDateTime(session.endedAt)
    : END_UNRECORDED_VALUE;
}

/** The "Ended" metadata value for a session that has not been observed to end. */
const STILL_RUNNING_VALUE = "Still running";

/** The "Ended" metadata value for a terminal session carrying no end instant. */
const END_UNRECORDED_VALUE = "Not recorded";
