"use client";

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
import { ClockIcon } from "lucide-react";
import { PropertyValue } from "./property-values";

/**
 * FEA-4275: the session-detail Properties "Duration" row, extracted from
 * `agent-session-detail-view.tsx` (a grandfathered, shrink-only file) into its
 * own sibling so the composition lives in one testable place and the hot file
 * shrinks.
 *
 * ISS-5131: the row prints the session's wall time under the one Duration rule
 * ({@link resolveSessionDetailDurationWindow}) — `now - start` while running,
 * `end - start` once terminal — the same window the Sessions LIST cell and both
 * detail Duration cards read, so this row cannot disagree with any of them. That
 * shared derivation is the point: ISS-4688 fixed an earlier split where this row
 * rendered an em-dash beside a Duration card showing "4h 54m".
 *
 * ISS-5575: the derivation is shared on its INPUT too. It used to run the rule
 * over the raw stored status while the list mapper ran it over the DISPLAYED
 * one, so the two disagreed for exactly the rows the list badges "Stale".
 *
 * IT IS A HEADLINE, NOT A DECOMPOSITION (#4409 review). The row used to read
 * "<wall> | <active> | waiting on you", which scanned as one three-way split of
 * a single span, and shipping the corrected headline beside the old sub-facts
 * broke that scan outright: `active` and `waitingUser` are the COLLECTOR's
 * pre-formatted turn-gap projection, and `session-trace-duration.ts` (FEA-3582)
 * clamps both to the same window it used for its own `wallClock` — a window
 * anchored on LAST ACTIVITY, not on `endedAt`. On the session ISS-5131 was filed
 * for (`019fb3e3`: activity end 170h out, `endedAt` 31h) that is a "31h wall |
 * 40h active" row: a component more than the total beside it, with a
 * pipe-separated list — the strongest "these add up" signal there is — inviting
 * the reader to sum them.
 *
 * The two sub-facts are dropped rather than re-derived because the UI cannot
 * re-derive them: they arrive as formatted strings already clamped server-side,
 * so recomputing containment here would be the UI compensating for a producer
 * window — the exact move that turned one backend defect into a worse one. The
 * Activity breakdown panel on this same screen already owns turn-gap time, and
 * it owns it against its own stated window. Re-clamping the collector's
 * sub-measures to the session's own end is `session-trace-duration.ts`'s job.
 *
 * The "wall" QUALIFIER goes with them. It existed to separate two measures the
 * old resolver returned behind one word; there is one measure now, and the
 * timeline axis on this same screen says "calendar span" precisely so it would
 * not collide with a Duration meaning observed-running time. With Duration a
 * plain start-to-end clock span, both numbers are calendar measures and "wall"
 * separated nothing — it just put an unexplained second word on a row already
 * labeled Duration.
 */
export function SessionDurationProperty({
  session,
}: Readonly<{ session: SessionDurationPropertySession }>) {
  // ISS-5131 (#4409 review): a RUNNING session's Duration is measured to `now`,
  // so `now` has to actually advance. `resolveSessionWallClockLabel` takes the
  // instant as an argument rather than reading the clock itself, which means a
  // component that forgot to tick would render a value frozen at mount and
  // caption it "Start to now" — not stale, false. The tick is skipped outright
  // once the window is bounded: a terminal session's span cannot change, and a
  // detail page left open on one should not re-render on a timer forever.
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
  // em-dash exactly when the list cell does — the identity this row's docstring
  // has always claimed.
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
  /*
   * ISS-5575 (#review, visual-QA HIGH): the dash now needs a reason. This row is
   * the ONLY surface a default user sees this change on — the Overview card has
   * no production caller (ISS-5072) and the strip is flag-gated — and it
   * rendered a bare em-dash with no hover copy and nothing in its accessible
   * name. "The badge already says Stale" does not rescue it: with the
   * prototype-parity flag off there is no status chip in the title at all, and
   * the Status row in this same panel reads the OTHER axis ("Running", ISS-5695).
   *
   * `PropertyValue` already owns this exact row shape — `.prd-prop` + label +
   * value — plus the `explanation` plumbing that makes the sentence both the
   * tooltip and the tail of the accessible name (WCAG 2.5.3). Composing it
   * deletes a hand-rolled copy of a catalog row instead of growing one.
   */
  return (
    <PropertyValue
      explanation={
        resolveSessionDetailDurationEmptyReason({
          // ISS-6455: the same two fields the window read, so the sentence
          // cannot describe a state the number was not resolved from.
          awaitingInputSince: session.awaitingInputSince,
          endedAt: session.endedAt,
          lastActivityAt: session.lastActivityAt,
          now,
          startedAt: session.startedAt,
          status: session.status,
          window,
        }) ?? undefined
      }
      icon={ClockIcon}
      label="Duration"
    >
      {wallClock ?? <GridEmptyValue />}
    </PropertyValue>
  );
}

/**
 * ISS-4688: the narrow structural slice of `AgentSessionDetail` this row reads.
 * Declared structurally rather than importing the full detail type so the row
 * stays testable from a small literal, while the single production call site
 * (`SessionPropertiesExpanded`) passes its `session` straight through — the same
 * `session={session}` shape the neighbouring `CacheWriteTtlProperty` and
 * `CodexRuntimeProperties` rows use.
 *
 * The Duration window is resolved HERE, from the session's own status and
 * `endedAt`, rather than threaded in as props: that keeps it identical to the one
 * `session-table-row.ts` computes for the list cell, so a future call site cannot
 * silently supply different bounds and re-open the ISS-4631 list<->detail drift.
 */
export type SessionDurationPropertySession = Readonly<{
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
   * Optional for the same version-skew reason as the rest of the slice, and
   * already on the `session` the single production call site passes through.
   */
  lastActivityAt?: Date | string | null;
  /**
   * ISS-5575 (wongk, #4971): the durable awaiting-input signal. A desktop LOCAL
   * detail arrives as raw `active` carrying this rather than a projected
   * `waiting`, and without it the Duration folds to Stale while the title chip
   * on the same screen still reads "Waiting".
   */
  awaitingInputSince?: Date | string | null;
}>;
