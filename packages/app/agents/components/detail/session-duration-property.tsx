"use client";

import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { ClockIcon } from "lucide-react";
import { PropertyValue } from "./property-values";
import {
  type SessionDurationValueProps,
  type SessionDurationValueSession,
  useSessionDurationValue,
} from "./values/session-duration-value";

/**
 * FEA-4275: the session-detail Properties "Duration" row, extracted from
 * `agent-session-detail-view.tsx` into its
 * own sibling so the composition lives in one testable place and the hot file
 * shrinks. PLN-2169 M2: the derivation is `useSessionDurationValue`, built to
 * be shared with the Details tab (M3); this row is the label and the
 * `PropertyValue` chrome around that one figure and its sentence.
 *
 * ISS-5131: the row prints the session's wall time under the one Duration rule
 * — `now - start` while running, `end - start` once terminal — the same window
 * the Sessions LIST cell and both detail Duration cards read, so this row cannot
 * disagree with any of them. That shared derivation is the point: ISS-4688 fixed
 * an earlier split where this row rendered an em-dash beside a Duration card
 * showing "4h 54m".
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
export function SessionDurationProperty(props: SessionDurationValueProps) {
  const { explanation, wallClock } = useSessionDurationValue(props);
  /*
   * ISS-5575 (#review, visual-QA HIGH): the dash needs a reason. This row is
   * the ONLY surface a default user sees this change on — the Overview card has
   * no production caller (ISS-5072) and the strip is flag-gated — and it
   * rendered a bare em-dash with no hover copy and nothing in its accessible
   * name. "The badge already says Stale" does not rescue it: with the
   * prototype-parity flag off there is no status chip in the title at all, and
   * the Status row in this same panel reads the OTHER axis ("Running", ISS-5695).
   *
   * `PropertyValue` already owns this exact row shape — `.prd-prop` + label +
   * value — plus the `explanation` plumbing that makes the sentence both the
   * tooltip and the tail of the accessible name (WCAG 2.5.3).
   */
  return (
    <PropertyValue explanation={explanation} icon={ClockIcon} label="Duration">
      {wallClock ?? <GridEmptyValue />}
    </PropertyValue>
  );
}

/** The slice under the row's own name, which `session-timeline-summary.tsx` refers to. */
export type SessionDurationPropertySession = SessionDurationValueSession;
