"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  isSessionDetailDurationClockRelevant,
  resolveSessionDetailDurationEmptyReason,
  resolveSessionDetailDurationWindow,
} from "@repo/app/agents/lib/session-detail-duration-window";
import {
  resolveSessionWallClockLabel,
  SESSION_DURATION_TICK_MS,
} from "@repo/app/agents/lib/session-duration";
import { useCoarseNow } from "@repo/app/shared/hooks/use-coarse-now";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import {
  joinPropertySentences,
  resolveMetricProvenanceNote,
  SessionProvenanceMetric,
} from "../session-metric-provenance";

/**
 * PLN-2169 M2: the Duration VALUE's derivation — the live clock, the one
 * Duration window, and the row's sentence — read by the Properties row
 * (`SessionDurationProperty`) and built for the Details tab's `DurationCell`
 * (mounted there by M3), so the figure and its reason resolve from ONE `now`
 * wherever they are drawn.
 *
 * ISS-5131: the figure is the session's wall time under the one Duration rule
 * ({@link resolveSessionDetailDurationWindow}) — `now - start` while running,
 * `end - start` once terminal — the same window the Sessions LIST cell and both
 * detail Duration cards read, so no surface can disagree with another.
 */
export function useSessionDurationValue({
  discloseEvidence,
  session,
}: SessionDurationValueProps): SessionDurationValueState {
  // ISS-5131 (#4409 review): a RUNNING session's Duration is measured to `now`,
  // so `now` has to actually advance. `resolveSessionWallClockLabel` takes the
  // instant as an argument rather than reading the clock itself, which means a
  // caller that forgot to tick would render a value frozen at mount and caption
  // it "Start to now" — not stale, false. The tick is skipped outright once the
  // window is bounded: a terminal session's span cannot change, and a detail
  // page left open on one should not re-render on a timer forever.
  //
  // ISS-5575: the tick gates on the RAW status's duration lifecycle rather than
  // on the window it feeds, because the window is DOWNSTREAM of `now` since the
  // displayed status moved into it — reading `window.kind` to decide whether to
  // advance the clock the window is resolved against is the cycle. See
  // `isSessionDetailDurationClockRelevant` for why that predicate, and not the
  // status-clock one, which freezes an awaiting-input run.
  const now = useCoarseNow(
    SESSION_DURATION_TICK_MS,
    isSessionDetailDurationClockRelevant(session)
  );
  // ISS-5575: resolved from the status this page DISPLAYS, through the LIST
  // mapper's own resolver, so a silent `active` run's Duration goes to the
  // em-dash exactly when the list cell does.
  const window = resolveSessionDetailDurationWindow({
    awaitingInputSince: session.awaitingInputSince,
    endedAt: session.endedAt,
    lastActivityAt: session.lastActivityAt,
    now,
    startedAt: session.startedAt,
    status: session.status,
  });
  const wallClock = resolveSessionWallClockLabel(
    session.startedAt ?? null,
    window,
    now.getTime()
  );
  const explanation = joinPropertySentences(
    resolveSessionDetailDurationEmptyReason({
      // ISS-6455: the same two fields the window read, so the sentence cannot
      // describe a state the number was not resolved from.
      awaitingInputSince: session.awaitingInputSince,
      endedAt: session.endedAt,
      lastActivityAt: session.lastActivityAt,
      now,
      startedAt: session.startedAt,
      status: session.status,
      window,
    }),
    // ISS-7427 (AC4): gated on the label about to be painted, so a Duration
    // that resolved to the em-dash keeps only its empty reason.
    resolveMetricProvenanceNote({
      disclosureEnabled: discloseEvidence === true,
      evidenceCoverage: session.evidenceCoverage,
      metric: SessionProvenanceMetric.Duration,
      valueIsSourceBacked: wallClock !== null,
    })
  );
  return { explanation, wallClock };
}

export function SessionDurationValue(props: SessionDurationValueProps) {
  const { wallClock } = useSessionDurationValue(props);
  return wallClock ?? <GridEmptyValue />;
}

export type SessionDurationValueProps = Readonly<{
  /**
   * ISS-7427 (AC4): the evidence-disclosure gate, threaded from the panel rather
   * than read from a hook here — the value is deliberately drivable from a small
   * literal (see {@link SessionDurationValueSession}) and a hook would put a
   * provider between it and its tests. Absent/false means say nothing.
   */
  discloseEvidence?: boolean;
  session: SessionDurationValueSession;
}>;

export type SessionDurationValueState = Readonly<{
  explanation: string | undefined;
  wallClock: string | null;
}>;

/**
 * ISS-4688: the narrow structural slice of `AgentSessionDetail` the value
 * reads. Declared structurally rather than importing the full detail type so
 * it stays testable from a small literal, while production call sites pass
 * their `session` straight through.
 *
 * The Duration window is resolved HERE, from the session's own status and
 * `endedAt`, rather than threaded in as props: that keeps it identical to the one
 * `session-table-row.ts` computes for the list cell, so a future call site cannot
 * silently supply different bounds and re-open the ISS-4631 list<->detail drift.
 */
export type SessionDurationValueSession = Readonly<{
  /**
   * ISS-5131: the session's lifecycle status, which with `endedAt` is the whole
   * input to the Duration rule. Optional for the same version-skew reason as the
   * timestamps — an older payload that omits it is `Indeterminate` and resolves
   * by evidence (an `endedAt` bounds the span, its absence leaves it
   * unmeasurable) rather than by guess.
   */
  status?: string | null;
  startedAt?: Date | string | null;
  endedAt?: Date | string | null;
  /**
   * ISS-5575: the staleness anchor the DISPLAYED status is derived from.
   * Optional for the same version-skew reason as the rest of the slice.
   */
  lastActivityAt?: Date | string | null;
  /**
   * ISS-5575 (whitlockk, #4971): the durable awaiting-input signal. A desktop LOCAL
   * detail arrives as raw `active` carrying this rather than a projected
   * `waiting`, and without it the Duration folds to Stale while the title chip
   * on the same screen still reads "Waiting".
   */
  awaitingInputSince?: Date | string | null;
  /**
   * ISS-7427 (AC4): the server's evidence verdict, for the provenance sentence.
   * `undefined` means the server does not classify — never that the main
   * archive is readable. See `AgentSessionDetail.evidenceCoverage`.
   */
  evidenceCoverage?: AgentSessionDetail["evidenceCoverage"];
}>;
